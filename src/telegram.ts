import type { FormData } from './validation.js'
import {
  type DirectusContext,
  escapeHtml,
  getPublicFilesUrl,
  isImageMimeType,
  getFormTypeLabel,
  extractCustomFields,
  parseCalculatorData,
  splitLabeledMessage,
  formatPrice,
  formatShortDate,
  DEVICE_LABELS,
} from './shared.js'

interface TelegramConfig {
  botToken: string
  chatIds: string[]
}

function loadTelegramConfig(): TelegramConfig {
  const chatIds: string[] = []

  const rawChatIds = process.env.TG_LEADS_CHAT_IDS || ''
  rawChatIds.split(',').forEach(id => {
    const trimmed = id.trim()
    if (trimmed && !chatIds.includes(trimmed)) chatIds.push(trimmed)
  })

  return {
    botToken: process.env.TG_LEADS_BOT_TOKEN || '',
    chatIds,
  }
}

function buildFieldsBlock(data: FormData): string {
  const fields = extractCustomFields(data)
  if (fields.length === 0) return ''

  return fields
    .map(({ label, value }) => `• <b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`)
    .join('\n')
}

function buildAttachmentsBlock(data: FormData, excludeImages: boolean): string {
  if (!Array.isArray(data.attachments) || data.attachments.length === 0) {
    return ''
  }

  const uploaded = data.attachments.filter((item) => {
    if (item.status === 'failed') return false
    if (excludeImages && isImageMimeType(item.mimeType)) return false
    return true
  })
  const failed = data.attachments.filter(item => item.status === 'failed')

  const lines: string[] = []

  if (uploaded.length > 0) {
    lines.push('<b>📎 Вложения:</b>')
    for (const item of uploaded.slice(0, 8)) {
      const suffix = item.url ? ` (${item.url})` : ''
      lines.push(`• ${escapeHtml(item.name)}${suffix}`)
    }
  }

  if (failed.length > 0) {
    lines.push('<b>⚠️ Не загружены:</b>')
    for (const item of failed.slice(0, 8)) {
      const reason = item.reason ? ` — ${item.reason}` : ''
      lines.push(`• ${escapeHtml(item.name)}${escapeHtml(reason)}`)
    }
  }

  return lines.join('\n')
}

function formatMessage(data: FormData, sourceUrl?: string, excludeImages = false): string {
  const typeLabel = getFormTypeLabel(data)
  const calc = parseCalculatorData(data)

  let message = `<b>Новая заявка: ${escapeHtml(typeLabel)}</b>\n\n`

  // Contacts
  message += `👤 <b>Имя:</b> ${escapeHtml(data.name)}\n`
  message += `📞 <b>Телефон:</b> ${escapeHtml(data.phone)}\n`
  if (data.email) {
    message += `📧 <b>Email:</b> ${escapeHtml(data.email)}\n`
  }

  if (calc) {
    // Calculator form — structured output
    const sel = calc.selection
    message += `\n📐 <b>Параметры:</b>\n`
    if (sel.timber?.label) message += `• Материал стен: ${escapeHtml(sel.timber.label)}\n`
    if (sel.foundation?.label) message += `• Фундамент: ${escapeHtml(sel.foundation.label)}\n`
    if (sel.roof?.label) message += `• Кровля: ${escapeHtml(sel.roof.label)}\n`

    if (calc.total?.value && calc.total.value > 0) {
      message += `\n💰 <b>Итого: ${formatPrice(calc.total.value)} ₽</b>\n`
    }
    if (calc.total?.onRequest) {
      message += `<i>(Точная цена по запросу)</i>\n`
    }

    // Project link
    const project = calc.project
    if (project) {
      const label = project.article
        ? `Проект ${project.article}`
        : project.title || ''
      const size = project.size ? ` (${project.size})` : ''
      if (label) {
        const text = `${escapeHtml(label)}${escapeHtml(size)}`
        if (sourceUrl) {
          message += `\n🏠 <a href="${escapeHtml(sourceUrl)}">${text}</a>\n`
        }
        else {
          message += `\n🏠 ${text}\n`
        }
      }
    }
  }
  else {
    // Regular form
    if (data.message) {
      message += `\n💬 <b>Сообщение:</b>\n${escapeHtml(data.message)}\n`
    }

    const fieldsBlock = buildFieldsBlock(data)
    if (fieldsBlock) {
      message += `\n🗂 <b>Поля формы:</b>\n${fieldsBlock}\n`
    }

    const attachmentsBlock = buildAttachmentsBlock(data, excludeImages)
    if (attachmentsBlock) {
      message += `\n${attachmentsBlock}\n`
    }

    if (sourceUrl) {
      message += `\n🔗 <b>Страница:</b> ${escapeHtml(sourceUrl)}\n`
    }
  }

  // Footer: device + date
  const footerParts: string[] = []
  if (data.device) {
    const deviceLabel = DEVICE_LABELS[data.device] || data.device
    footerParts.push(deviceLabel)
  }
  footerParts.push(formatShortDate())
  message += `\n${footerParts.join(' • ')}`

  if (message.length > 3900) {
    message = `${message.slice(0, 3890)}\n…`
  }

  return message
}

// ——— Rich message (sendRichMessage, Bot API 10.1+) ———
//
// Плюс над обычным sendMessage: настоящие markdown-таблицы (проверено вживую
// против api.telegram.org). Используется только когда нет вложений-картинок
// (InputRichMessage не поддерживает фото) — с фото остаётся старый HTML-путь.

/**
 * skip_entity_detection обязателен: без него голый текст вида "https://..."
 * в имени/сообщении лида (не наша ссылка, а пользовательский ввод) сам
 * превращается в кликабельную ссылку менеджеру — потенциальный фишинг через
 * поле формы. Экранирование ниже защищает от намеренной markdown-разметки
 * (`[текст](url)`, `*`, `_` и т.п.) в том же пользовательском вводе.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]()#|~>]/g, '\\$&')
}

/** Экранирует URL для позиции `(...)` в markdown-ссылке — только символы, ломающие синтаксис. */
function escapeMarkdownLinkUrl(url: string): string {
  return url.replace(/[()\\ ]/g, char => encodeURIComponent(char))
}

/** `tel:`-ссылка — оставляет только `+` и цифры, чтобы клик по номеру запускал звонок. */
function toTelHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`
}

function buildRichAttachmentsBlock(data: FormData): string {
  if (!Array.isArray(data.attachments) || data.attachments.length === 0) return ''

  const uploaded = data.attachments.filter(item => item.status !== 'failed')
  const failed = data.attachments.filter(item => item.status === 'failed')
  const lines: string[] = []

  if (uploaded.length > 0) {
    lines.push('**📎 Вложения:**')
    for (const item of uploaded.slice(0, 8)) {
      const suffix = item.url ? ` (${escapeMarkdownLinkUrl(item.url)})` : ''
      lines.push(`- ${escapeMarkdown(item.name)}${suffix}`)
    }
  }

  if (failed.length > 0) {
    lines.push('**⚠️ Не загружены:**')
    for (const item of failed.slice(0, 8)) {
      const reason = item.reason ? ` — ${escapeMarkdown(item.reason)}` : ''
      lines.push(`- ${escapeMarkdown(item.name)}${reason}`)
    }
  }

  return lines.join('\n')
}

/**
 * Markdown-версия formatMessage — только для случая "нет картинок-вложений".
 * `#` в начале — настоящий заголовок (RichBlockSectionHeading), не просто
 * жирный текст. Контакты внизу идут отдельными параграфами через ПУСТУЮ
 * строку (не список: буллеты не нужны) — одиночный \n внутри одного
 * параграфа CommonMark схлопывается в пробел, а не в перенос строки, из-за
 * этого "Имя/Телефон/Email" слипались в одну строку с переносом посреди
 * значения. Двойной \n — гарантированная граница блока.
 */
/**
 * Сворачивает "Проект" + "Размер" + "Площадь" в одну строку таблицы:
 * название — ссылкой на sourceUrl, размер/площадь — компактной второй
 * строкой внутри той же ячейки. Остальные ряды (Стены/Фундамент/...) не
 * трогает. "Стоимость дома" вынимается отдельно (не остаётся строкой
 * таблицы) — её рендерит отдельным блоком-цитатой вызывающий код.
 */
function mergeProjectRow(
  rows: { label: string, value: string, raw?: boolean }[],
  sourceUrl?: string,
): { hadProject: boolean, priceValue?: string } {
  const projectIdx = rows.findIndex(r => r.label === 'Проект')
  if (projectIdx === -1) return { hadProject: false }

  const sizeIdx = rows.findIndex(r => r.label === 'Размер')
  const areaIdx = rows.findIndex(r => r.label === 'Площадь')
  const priceIdx = rows.findIndex(r => r.label === 'Стоимость дома')

  const sizeParts = [sizeIdx, areaIdx].filter(i => i !== -1).map(i => escapeMarkdown(rows[i].value))
  const priceValue = priceIdx !== -1 ? rows[priceIdx].value : undefined

  const title = escapeMarkdown(rows[projectIdx].value)
  const valueLines = [sourceUrl ? `[${title}](${escapeMarkdownLinkUrl(sourceUrl)})` : title]
  if (sizeParts.length > 0) valueLines.push(sizeParts.join(' · '))

  rows[projectIdx] = { label: 'Проект', value: valueLines.join('<br>'), raw: true }
  ;[priceIdx, areaIdx, sizeIdx].filter(i => i !== -1).sort((a, b) => b - a).forEach(i => rows.splice(i, 1))

  return { hadProject: true, priceValue }
}

function buildRichMarkdown(data: FormData, sourceUrl?: string): string {
  const typeLabel = getFormTypeLabel(data)
  const deviceIcon = data.device ? (DEVICE_LABELS[data.device] || data.device).split(' ')[0] : ''

  let message = `# ${escapeMarkdown(typeLabel)}\n\n`
  message += `${deviceIcon ? `${deviceIcon} ` : ''}${formatShortDate()}\n\n`

  let plainMessage = ''
  let extraLines: string[] = []
  const rows: { label: string, value: string, raw?: boolean }[] = []

  if (data.message) {
    const split = splitLabeledMessage(data.message)
    if (split.rows.length >= 2) {
      rows.push(...split.rows)
      extraLines = split.extra
    }
    else {
      plainMessage = data.message
    }
  }

  let hadProject = false
  let priceValue: string | undefined

  if (rows.length > 0) {
    ({ hadProject, priceValue } = mergeProjectRow(rows, sourceUrl))
    message += '| Параметр | Значение |\n|:---|---:|\n'
    for (const { label, value, raw } of rows) {
      message += `| ${escapeMarkdown(label)} | ${raw ? value : escapeMarkdown(value)} |\n`
    }
  }
  else {
    const fields = extractCustomFields(data)
    if (fields.length > 0) {
      message += '**Поля формы:**\n'
      for (const { label, value } of fields) {
        message += `- ${escapeMarkdown(label)}: ${escapeMarkdown(value)}\n`
      }
    }
  }

  // Цена — отдельным блоком-цитатой с H3 внутри (заметнее строки таблицы).
  // "Цена по запросу", если строки "Стоимость дома" не было вовсе (у калькулятора
  // это означает hasOnRequest — фронт просто не пишет цену в сообщение).
  if (hadProject) {
    message += `\n> ### ${priceValue ? escapeMarkdown(priceValue) : 'Цена по запросу'}\n`
  }

  if (plainMessage) {
    message += `\n💬 ${escapeMarkdown(plainMessage)}\n`
  }
  if (extraLines.length > 0) {
    message += `\n${extraLines.map(line => escapeMarkdown(line)).join('\n\n')}\n`
  }

  const attachmentsBlock = buildRichAttachmentsBlock(data)
  if (attachmentsBlock) {
    message += `\n${attachmentsBlock}\n`
  }

  // Контакты — общий блок внизу, без буллетов.
  const contactLines: string[] = [
    `👤 Имя: ${escapeMarkdown(data.name)}`,
    `📞 Телефон: [${escapeMarkdown(data.phone)}](${toTelHref(data.phone)})`,
  ]
  if (data.email) {
    contactLines.push(`📧 Email: [${escapeMarkdown(data.email)}](mailto:${escapeMarkdownLinkUrl(data.email)})`)
  }
  message += `\n${contactLines.join('\n\n')}\n`

  if (message.length > 3900) {
    message = `${message.slice(0, 3890)}\n…`
  }

  return message
}

/**
 * Resolve public URLs for uploaded image attachments.
 * Queries directus_files to get filename_disk, then builds S3 URL.
 */
async function getImageUrls(
  attachments: FormData['attachments'],
  directusContext?: DirectusContext,
): Promise<string[]> {
  const publicFilesUrl = getPublicFilesUrl()
  if (!publicFilesUrl) {
    console.warn('[forms-handler] PUBLIC_FILES_URL not set, cannot send images to Telegram')
    return []
  }

  const imageAttachments = attachments.filter(
    item => item.status !== 'failed' && item.id && isImageMimeType(item.mimeType),
  )

  if (imageAttachments.length === 0) return []

  if (!directusContext) {
    console.warn('[forms-handler] No Directus context, cannot resolve image URLs')
    return []
  }

  const urls: string[] = []

  try {
    const schema = await directusContext.getSchema()
    const { ItemsService } = directusContext.services
    const filesService = new ItemsService('directus_files', {
      schema,
      accountability: { admin: true },
    })

    for (const attachment of imageAttachments.slice(0, 10)) {
      try {
        const file = await filesService.readOne(attachment.id, { fields: ['filename_disk'] })
        if (file?.filename_disk) {
          urls.push(`${publicFilesUrl}/${file.filename_disk}`)
        }
      }
      catch (err) {
        console.error(`[forms-handler] Failed to get filename_disk for file ${attachment.id}:`, err)
      }
    }
  }
  catch (err) {
    console.error('[forms-handler] Failed to query directus_files:', err)
  }

  return urls
}

async function callTelegramApi(
  config: TelegramConfig,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; description?: string; result?: any }> {
  const baseUrl = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'
  const response = await fetch(`${baseUrl}/bot${config.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json() as Promise<{ ok: boolean; description?: string; result?: any }>
}

async function sendTextMessage(
  config: TelegramConfig,
  chatId: string,
  text: string,
): Promise<boolean> {
  const result = await callTelegramApi(config, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  })

  if (!result.ok) {
    console.error(`[forms-handler] Telegram sendMessage error (chat ${chatId}):`, result.description)
    return false
  }
  return true
}

async function sendSinglePhoto(
  config: TelegramConfig,
  chatId: string,
  photoUrl: string,
  caption: string,
): Promise<boolean> {
  // sendPhoto caption limit is 1024 chars
  const truncatedCaption = caption.length > 1020
    ? `${caption.slice(0, 1010)}\n…`
    : caption

  const result = await callTelegramApi(config, 'sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    caption: truncatedCaption,
    parse_mode: 'HTML',
  })

  if (!result.ok) {
    console.error(`[forms-handler] Telegram sendPhoto error (chat ${chatId}):`, result.description)
    return false
  }
  return true
}

async function sendRichMessage(
  config: TelegramConfig,
  chatId: string,
  markdown: string,
): Promise<boolean> {
  const result = await callTelegramApi(config, 'sendRichMessage', {
    chat_id: chatId,
    rich_message: { markdown, skip_entity_detection: true },
  })

  if (!result.ok) {
    console.error(`[forms-handler] Telegram sendRichMessage error (chat ${chatId}):`, result.description)
    return false
  }
  return true
}

async function sendMediaGroup(
  config: TelegramConfig,
  chatId: string,
  imageUrls: string[],
): Promise<boolean> {
  const media = imageUrls.map((url, index) => ({
    type: 'photo' as const,
    media: url,
    ...(index === 0 ? { caption: `📸 Вложения к заявке (${imageUrls.length})` } : {}),
  }))

  const result = await callTelegramApi(config, 'sendMediaGroup', {
    chat_id: chatId,
    media,
  })

  if (!result.ok) {
    console.error(`[forms-handler] Telegram sendMediaGroup error (chat ${chatId}):`, result.description)
    return false
  }
  return true
}

/**
 * Send notification to a single chat. Returns true if at least one message was sent.
 */
async function sendToChat(
  config: TelegramConfig,
  chatId: string,
  data: FormData,
  imageUrls: string[],
  sourceUrl?: string,
): Promise<boolean> {
  if (imageUrls.length === 1) {
    const text = formatMessage(data, sourceUrl, true)

    if (text.length <= 1020) {
      const sent = await sendSinglePhoto(config, chatId, imageUrls[0], text)
      if (sent) return true
    }
    else {
      const photoSent = await sendSinglePhoto(config, chatId, imageUrls[0], '📸 Вложение к заявке')
      if (photoSent) {
        const sent = await sendTextMessage(config, chatId, text)
        if (sent) return true
      }
    }

    // Fallback to text-only if photo fails
    console.warn(`[forms-handler] Photo send failed for chat ${chatId}, falling back to text`)
    const fallbackText = formatMessage(data, sourceUrl, false)
    return sendTextMessage(config, chatId, fallbackText)
  }

  if (imageUrls.length > 1) {
    const groupSent = await sendMediaGroup(config, chatId, imageUrls)
    if (!groupSent) {
      console.warn(`[forms-handler] Media group failed for chat ${chatId}, falling back to text`)
    }
    const text = formatMessage(data, sourceUrl, groupSent)
    return sendTextMessage(config, chatId, text)
  }

  // No image attachments — try the rich table format (sendRichMessage doesn't
  // support photos, hence the two branches above staying on plain sendMessage).
  // Caught explicitly (not just ok:false) — a thrown network error here must
  // still fall through to the plain-text retry below, not abort the chat.
  let richSent = false
  try {
    richSent = await sendRichMessage(config, chatId, buildRichMarkdown(data, sourceUrl))
  }
  catch (richError) {
    console.error(`[forms-handler] sendRichMessage threw for chat ${chatId}:`, richError)
  }
  if (richSent) return true

  console.warn(`[forms-handler] Rich message failed for chat ${chatId}, falling back to plain text`)
  const text = formatMessage(data, sourceUrl, false)
  return sendTextMessage(config, chatId, text)
}

export interface TelegramNotificationResult {
  sent: boolean
}

export async function sendTelegramNotification(
  data: FormData,
  submissionId: string,
  sourceUrl?: string,
  directusContext?: DirectusContext,
): Promise<TelegramNotificationResult> {
  if (process.env.FORMS_TELEGRAM_ENABLED !== 'true') {
    console.log('[forms-handler] Telegram notifications disabled (FORMS_TELEGRAM_ENABLED != true)')
    return { sent: false }
  }

  const config = loadTelegramConfig()

  if (!config.botToken || config.chatIds.length === 0) {
    console.warn('[forms-handler] Telegram not configured (missing TG_LEADS_BOT_TOKEN or chat IDs)')
    return { sent: false }
  }

  try {
    const imageUrls = await getImageUrls(data.attachments, directusContext)

    let anySent = false
    for (const chatId of config.chatIds) {
      try {
        const sent = await sendToChat(config, chatId, data, imageUrls, sourceUrl)
        if (sent) {
          console.log(`[forms-handler] Notification sent to chat ${chatId} for submission ${submissionId}`)
          anySent = true
        }
      }
      catch (chatError) {
        console.error(`[forms-handler] Failed to send to chat ${chatId}:`, chatError)
      }
    }

    return { sent: anySent }
  }
  catch (error) {
    console.error('[forms-handler] Failed to send Telegram notification:', error)
    return { sent: false }
  }
}
