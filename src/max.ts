import type { FormData } from './validation.js'
import {
  type DirectusContext,
  type ResolvedAttachment,
  escapeHtml,
  escapeHtmlAttr,
  extractCustomFields,
  getFormTypeLabel,
  parseCalculatorData,
  formatPrice,
  formatShortDate,
  DEVICE_LABELS,
  resolveAttachmentUrls,
} from './shared.js'

/**
 * Уведомления о заявках в мессенджер MAX (Bot API, dev.max.ru).
 *
 * Сверено с документацией 25.09.2026:
 * - `POST /messages?chat_id=…` (чат/канал) или `?user_id=…` (личка);
 *   тело `{ text, format: 'html', notify }`, текст ≤ 4000 символов,
 *   не чаще 2 сообщений в секунду в один диалог;
 * - токен — голым заголовком `Authorization: <token>` (без Bearer; query
 *   `access_token` больше не принимается);
 * - `GET /chats` отключён в июне 2026 — получателей берём только из env;
 * - документация велит `platform-api2.max.ru`, но он подписан корнем Минцифры,
 *   которого нет в стандартных хранилищах. Поэтому база — env `MAX_API_BASE`
 *   с дефолтом `https://botapi.max.ru`.
 *
 * Разметка: `<b> <i> <u> <s> <a href> <blockquote>`. Заголовки `<h2>`+ на
 * практике пропадают, списков нет — пункты печатаем строками с «•».
 */

const DEFAULT_MAX_API_BASE = 'https://botapi.max.ru'
const MAX_TEXT_LIMIT = 4000
const TEXT_SOFT_LIMIT = 3900

interface MaxRecipient {
  kind: 'chat_id' | 'user_id'
  id: string
}

interface MaxConfig {
  botToken: string
  apiBase: string
  recipients: MaxRecipient[]
}

export interface MaxNotificationResult {
  sent: boolean
}

const ID_RE = /^-?\d{1,20}$/

function parseIds(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map(id => id.trim())
    .filter(id => ID_RE.test(id))
}

function loadMaxConfig(): MaxConfig {
  const recipients: MaxRecipient[] = []
  const seen = new Set<string>()

  const add = (kind: MaxRecipient['kind'], id: string) => {
    const key = `${kind}:${id}`
    if (seen.has(key)) return
    seen.add(key)
    recipients.push({ kind, id })
  }

  parseIds(process.env.MAX_CHAT_IDS).forEach(id => add('chat_id', id))
  parseIds(process.env.MAX_USER_IDS).forEach(id => add('user_id', id))

  return {
    botToken: (process.env.MAX_BOT_TOKEN || '').trim(),
    apiBase: (process.env.MAX_API_BASE || DEFAULT_MAX_API_BASE).trim().replace(/\/+$/, ''),
    recipients,
  }
}

/**
 * Любая строка, которая идёт в лог, проходит через эту функцию: токен MAX
 * вырезается, даже если API или fetch вдруг вернут его в тексте ошибки.
 */
function redact(text: string, token: string): string {
  if (!token) return text
  return text.split(token).join('***')
}

/**
 * Клиент MAX принимает «1 500 000» за телефонный номер и красит его ссылкой.
 * Узкий неразрывный пробел (U+202F) между разрядами это снимает. Трогаем
 * только суммы с «₽»/«руб» — телефон клиента пусть остаётся кликабельным.
 */
export function protectPrices(text: string): string {
  return text.replace(
    /\d{1,3}(?:[ \u00A0\u202F]\d{3})+(?=[ \u00A0\u202F]*(?:₽|руб))/g,
    match => match.replace(/[ \u00A0]/g, '\u202F'),
  )
}

function isHttpUrl(value: string | undefined): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function buildAttachmentsLines(
  data: FormData,
  resolved: Map<string, ResolvedAttachment>,
): string[] {
  if (!Array.isArray(data.attachments) || data.attachments.length === 0) return []

  const uploaded = data.attachments.filter(item => item.status !== 'failed')
  const failed = data.attachments.filter(item => item.status === 'failed')
  const lines: string[] = []

  if (uploaded.length > 0) {
    lines.push('', '<b>📎 Вложения:</b>')
    for (const item of uploaded.slice(0, 8)) {
      const own = item.id ? resolved.get(item.id) : undefined
      if (own) {
        // URL собран из PUBLIC_FILES_URL + filename_disk — наш, ему можно быть ссылкой.
        lines.push(`• <a href="${escapeHtmlAttr(own.url)}">${escapeHtml(item.name)}</a>`)
      }
      else {
        // url из тела анонимного POST — только текстом, как в Telegram (фикс 5h56).
        const suffix = item.url ? ` (${escapeHtml(item.url)})` : ''
        lines.push(`• ${escapeHtml(item.name)}${suffix}`)
      }
    }
  }

  if (failed.length > 0) {
    lines.push('', '<b>⚠️ Не загружены:</b>')
    for (const item of failed.slice(0, 8)) {
      const reason = item.reason ? ` — ${item.reason}` : ''
      lines.push(`• ${escapeHtml(item.name)}${escapeHtml(reason)}`)
    }
  }

  return lines
}

/**
 * Обрезка до лимита MAX без порчи разметки: режем по границе строки. Каждый
 * тег открывается и закрывается в пределах своей строки, а многострочный
 * текст клиента (сообщение) — экранированный текст без тегов.
 */
function truncateMessage(message: string): string {
  if (message.length <= TEXT_SOFT_LIMIT) return message
  const cut = message.slice(0, TEXT_SOFT_LIMIT - 2)
  const lastNewline = cut.lastIndexOf('\n')
  let head = lastNewline > 0 ? cut.slice(0, lastNewline) : cut
  // Строка без переносов длиннее лимита: убираем хвост с недописанным
  // тегом или сущностью.
  if (lastNewline <= 0) head = head.replace(/<[^>]*$/, '').replace(/&[#\w]*$/, '')
  return `${head}\n…`
}

export function formatMaxMessage(
  data: FormData,
  sourceUrl?: string,
  resolvedAttachments: ResolvedAttachment[] = [],
): string {
  const typeLabel = getFormTypeLabel(data)
  const calc = parseCalculatorData(data)

  const lines: string[] = [
    `<b>Новая заявка: ${escapeHtml(typeLabel)}</b>`,
    '',
    `👤 <b>Имя:</b> ${escapeHtml(data.name)}`,
    `📞 <b>Телефон:</b> ${escapeHtml(data.phone)}`,
  ]

  if (data.email) {
    lines.push(`📧 <b>Email:</b> ${escapeHtml(data.email)}`)
  }

  if (calc) {
    const sel = calc.selection
    lines.push('', '📐 <b>Параметры:</b>')
    if (sel.timber?.label) lines.push(`• Материал стен: ${escapeHtml(sel.timber.label)}`)
    if (sel.foundation?.label) lines.push(`• Фундамент: ${escapeHtml(sel.foundation.label)}`)
    if (sel.roof?.label) lines.push(`• Кровля: ${escapeHtml(sel.roof.label)}`)

    if (calc.total?.value && calc.total.value > 0) {
      lines.push('', `💰 <b>Итого: ${formatPrice(calc.total.value)} ₽</b>`)
    }
    if (calc.total?.onRequest) {
      lines.push('<i>(Точная цена по запросу)</i>')
    }

    const project = calc.project
    if (project) {
      const label = project.article
        ? `Проект ${project.article}`
        : project.title || ''
      const size = project.size ? ` (${project.size})` : ''
      if (label) {
        const text = `${escapeHtml(label)}${escapeHtml(size)}`
        lines.push('', isHttpUrl(sourceUrl)
          ? `🏠 <a href="${escapeHtmlAttr(sourceUrl)}">${text}</a>`
          : `🏠 ${text}`)
      }
    }
  }
  else {
    if (data.message) {
      lines.push('', '💬 <b>Сообщение:</b>', escapeHtml(data.message))
    }

    const fields = extractCustomFields(data)
    if (fields.length > 0) {
      lines.push('', '🗂 <b>Поля формы:</b>')
      for (const { label, value } of fields) {
        lines.push(`• <b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`)
      }
    }

    const byId = new Map<string, ResolvedAttachment>()
    for (const item of resolvedAttachments) {
      if (item.id) byId.set(item.id, item)
    }
    lines.push(...buildAttachmentsLines(data, byId))

    if (sourceUrl) {
      // Адрес страницы приходит из тела запроса/Referer — печатаем текстом.
      lines.push('', `🔗 <b>Страница:</b> ${escapeHtml(sourceUrl)}`)
    }
  }

  const footerParts: string[] = []
  if (data.device) footerParts.push(DEVICE_LABELS[data.device] || data.device)
  footerParts.push(formatShortDate())
  lines.push('', escapeHtml(footerParts.join(' • ')))

  return truncateMessage(protectPrices(lines.join('\n')))
}

/** Запасной вариант без разметки — если MAX отверг HTML (400). */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

interface MaxApiError {
  status: number
  code?: string
  message?: string
}

async function postMessage(
  config: MaxConfig,
  recipient: MaxRecipient,
  body: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false, error: MaxApiError }> {
  const query = new URLSearchParams({
    [recipient.kind]: recipient.id,
    disable_link_preview: 'true',
  })

  const response = await fetch(`${config.apiBase}/messages?${query}`, {
    method: 'POST',
    headers: {
      // Голый токен, без «Bearer » — с префиксом MAX отвечает 401.
      'Authorization': config.botToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (response.ok) return { ok: true }

  let code: string | undefined
  let message: string | undefined
  try {
    const payload = await response.json() as { code?: unknown, message?: unknown }
    if (typeof payload?.code === 'string') code = payload.code
    if (typeof payload?.message === 'string') message = payload.message.slice(0, 200)
  }
  catch {
    // тело не JSON — хватит HTTP-статуса
  }

  return { ok: false, error: { status: response.status, code, message } }
}

function formatMaxError(error: MaxApiError, token: string): string {
  return redact(
    `HTTP ${error.status} code=${error.code ?? '?'} msg=${error.message ?? 'no message'}`,
    token,
  )
}

function describeRecipient(recipient: MaxRecipient): string {
  return recipient.kind === 'chat_id' ? `chat ${recipient.id}` : `user ${recipient.id}`
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function sendToRecipient(
  config: MaxConfig,
  recipient: MaxRecipient,
  html: string,
): Promise<boolean> {
  const who = describeRecipient(recipient)
  const htmlBody = { text: html, format: 'html', notify: true }

  let result = await postMessage(config, recipient, htmlBody)

  // 429 — лимит 2 сообщения/с на диалог: одна повторная попытка через секунду.
  if (!result.ok && result.error.status === 429) {
    await sleep(1000)
    result = await postMessage(config, recipient, htmlBody)
  }

  // 400 — MAX не принял разметку: отправляем ту же заявку простым текстом,
  // лид важнее оформления.
  if (!result.ok && result.error.status === 400) {
    console.warn(`[forms-handler] MAX rejected HTML (${who}): ${formatMaxError(result.error, config.botToken)} — retrying as plain text`)
    result = await postMessage(config, recipient, { text: htmlToPlainText(html), notify: true })
  }

  if (!result.ok) {
    console.error(`[forms-handler] MAX POST /messages error (${who}): ${formatMaxError(result.error, config.botToken)}`)
    return false
  }

  return true
}

export async function sendMaxNotification(
  data: FormData,
  submissionId: string,
  sourceUrl?: string,
  directusContext?: DirectusContext,
): Promise<MaxNotificationResult> {
  const config = loadMaxConfig()

  if (!config.botToken || config.recipients.length === 0) {
    console.log('[forms-handler] MAX not configured (missing MAX_BOT_TOKEN or MAX_CHAT_IDS/MAX_USER_IDS)')
    return { sent: false }
  }

  try {
    // Вложения в MAX — ссылками на файлы в S3 (PUBLIC_FILES_URL), без загрузки
    // картинок в MAX: заявке хватает ссылки, а загрузка — лишние запросы и лимиты.
    const hasUploads = Array.isArray(data.attachments)
      && data.attachments.some(item => item.status !== 'failed' && item.id)
    const resolved = hasUploads
      ? await resolveAttachmentUrls(data.attachments, directusContext)
      : []

    const html = formatMaxMessage(data, sourceUrl, resolved)
    if (html.length > MAX_TEXT_LIMIT) {
      // Страховка: truncateMessage держит 3900, сюда попадать не должны.
      console.warn(`[forms-handler] MAX message length ${html.length} exceeds ${MAX_TEXT_LIMIT}`)
    }

    let anySent = false
    for (const recipient of config.recipients) {
      try {
        const sent = await sendToRecipient(config, recipient, html)
        if (sent) {
          console.log(`[forms-handler] MAX notification sent to ${describeRecipient(recipient)} for submission ${submissionId}`)
          anySent = true
        }
      }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.error(`[forms-handler] Failed to send MAX notification to ${describeRecipient(recipient)}: ${redact(reason, config.botToken)}`)
      }
    }

    return { sent: anySent }
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`[forms-handler] Failed to send MAX notification: ${redact(reason, config.botToken)}`)
    return { sent: false }
  }
}
