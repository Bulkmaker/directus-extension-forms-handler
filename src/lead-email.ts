/**
 * Письмо о заявке: адаптивная HTML-вёрстка + текстовая альтернатива (multipart).
 *
 * Модуль самодостаточный — без импортов из остального расширения, чтобы его можно
 * было переносить между форками forms-handler одним файлом.
 *
 * Вёрстка под почтовые клиенты: таблицы, inline-стили, ширина 600px, светлая тема,
 * без внешних картинок и шрифтов. `<style>` в `<head>` — только улучшение для
 * телефонов (Gmail, Apple Mail); без него письмо тоже читается (ширины резиновые).
 * Outlook держит 600px через условный комментарий `[if mso]`.
 *
 * Весь пользовательский ввод экранируется. Ссылки строятся только из проверенных
 * значений: http(s)-адрес страницы, `tel:` из цифр телефона, `mailto:` из адреса,
 * прошедшего строгую проверку. Письму арендатору (`audience: 'tenant'`) не
 * достаются ссылка на CMS и служебная строка о маршруте — только владельцу.
 */

export interface LeadEmailData {
  form_key?: string | null
  form_title?: string | null
  type?: string | null
  name: string
  phone: string
  email?: string | null
  message?: string | null
  device?: string | null
  fields?: Record<string, unknown> | null
  field_meta?: Record<string, unknown> | null
  calculator_data?: Record<string, unknown> | null
}

export interface LeadEmailAttachment {
  name: string
  /** Публичная ссылка на файл (наша, из хранилища) — «Скачать». */
  url?: string | null
  /** Content-ID картинки, приложенной к письму, — показывается превью. */
  cid?: string
}

export interface LeadEmailOptions {
  audience: 'owner' | 'tenant'
  submissionId?: string | number | null
  sourceUrl?: string | null
  /** Ссылка на заявку в CMS. Печатается только в письме владельцу. */
  cmsItemUrl?: string | null
  /** Строка о маршруте («заявка ушла арендатору …»). Только владельцу. */
  routeNote?: string | null
  attachments?: LeadEmailAttachment[]
  /** Заголовок, если у формы нет form_title (например, «Контактная форма»). */
  fallbackTitle?: string | null
  now?: Date
}

export interface LeadEmail {
  subject: string
  html: string
  text: string
}

// ——— Экранирование и проверенные ссылки ————————————————————————————————

export function escapeEmailHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Однострочное значение: без управляющих символов, схлопнутые пробелы. */
function oneLine(value: unknown, max = 300): string {
  const text = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  }
  catch {
    return null
  }
}

export function siteDomain(sourceUrl: unknown): string {
  const href = safeHttpUrl(sourceUrl)
  if (!href) return ''
  return new URL(href).hostname.replace(/^www\./, '')
}

const STRICT_EMAIL_RE = /^[^\s@<>"'(),;:\\[\]]+@[^\s@<>"'(),;:\\[\]]+\.[^\s@<>"'(),;:\\[\]]+$/

export function isStrictEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && STRICT_EMAIL_RE.test(value)
}

/** Номер для `tel:` — «+» и цифры. Российские 8XXXXXXXXXX и 10 цифр приводятся к +7. */
export function telHref(phone: string): string | null {
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) return `tel:+7${digits.slice(1)}`
  if (digits.length === 10) return `tel:+7${digits}`
  return `tel:+${digits}`
}

/** «+7 999 111-22-33» для российских номеров, иначе как ввёл клиент. */
export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  let local = ''
  if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) local = digits.slice(1)
  else if (digits.length === 10) local = digits
  if (!local) return oneLine(phone, 40)
  return `+7 ${local.slice(0, 3)} ${local.slice(3, 6)}-${local.slice(6, 8)}-${local.slice(8, 10)}`
}

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

/** Московское время (UTC+3 без перехода на летнее с 2014 года), без зависимости от ICU. */
export function formatMoscowTime(date: Date): string {
  const msk = new Date(date.getTime() + 3 * 60 * 60 * 1000)
  const hh = String(msk.getUTCHours()).padStart(2, '0')
  const mm = String(msk.getUTCMinutes()).padStart(2, '0')
  return `${msk.getUTCDate()} ${MONTHS_GENITIVE[msk.getUTCMonth()]} ${msk.getUTCFullYear()}, ${hh}:${mm} (МСК)`
}

// ——— Содержимое заявки ————————————————————————————————————————————————

interface Row {
  label: string
  value: string
  /** Уже готовый безопасный HTML значения (ссылка). Иначе value экранируется. */
  html?: string
}

const CONTACT_KEYS = new Set([
  'name', 'client_name', 'full_name', 'fullname',
  'phone', 'client_phone', 'tel', 'telephone',
  'email', 'client_email',
  'message', 'request_message', 'estimate_summary', 'estimate_payload',
  'agree', 'privacy_consent', 'consent',
  'calculator_data', 'calculator_payload',
  'project_attachments', '_honeypot', '_loadTime', 'website',
])

/** Ключи, которые идут в блок «Источник», а не в детали заявки. */
const SOURCE_KEYS = new Set(['site_id', 'page', 'referrer', 'utm', 'calc', 'source_url', 'source_path', 'device'])

const FIELD_LABELS: Record<string, string> = {
  region: 'Район',
  topic: 'Услуга',
  service: 'Услуга',
  address: 'Адрес',
  city: 'Город',
  area: 'Площадь',
  object: 'Объект',
  comment: 'Комментарий',
}

const CALC_LABELS: Record<string, string> = {
  area: 'Площадь, м²',
  material: 'Материал',
  work: 'Работы',
  total: 'Итого',
}

const DEVICE_NAMES: Record<string, string> = {
  mobile: 'Телефон',
  tablet: 'Планшет',
  desktop: 'Компьютер',
}

const LABEL_LINE_RE = /^([^:\n]{1,40}):\s*(.+)$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function primitiveText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'да' : 'нет'
  if (Array.isArray(value)) {
    const parts = value.map(primitiveText).filter((item): item is string => Boolean(item))
    return parts.length > 0 ? parts.slice(0, 10).join(', ') : null
  }
  return null
}

/**
 * Сообщение формы часто собрано строками «Метка: значение» (услуга, расчёт, район) —
 * их показываем таблицей, остальное — текстом клиента.
 */
export function splitMessage(message: string): { rows: Row[], text: string } {
  const rows: Row[] = []
  const rest: string[] = []
  for (const raw of message.split('\n')) {
    const line = raw.trim()
    if (!line) {
      rest.push('')
      continue
    }
    const match = LABEL_LINE_RE.exec(line)
    if (match && !/https?$/i.test(match[1]!.trim())) {
      rows.push({ label: oneLine(match[1], 40), value: oneLine(match[2], 500) })
    }
    else {
      rest.push(raw.replace(/\s+$/, ''))
    }
  }
  return { rows, text: rest.join('\n').replace(/\n{3,}/g, '\n\n').trim() }
}

function fieldLabel(key: string, meta: Record<string, unknown> | null | undefined): string {
  const entry = meta?.[key]
  if (isPlainObject(entry) && typeof entry.label === 'string' && entry.label.trim()) return oneLine(entry.label, 60)
  return FIELD_LABELS[key] || key
}

function formatRub(value: number): string {
  return `${new Intl.NumberFormat('ru-RU').format(value)} ₽`
}

/** Калькулятор проектов домов (calculator_data.selection/total/project). */
function houseCalculatorRows(calc: Record<string, unknown> | null | undefined): Row[] {
  if (!isPlainObject(calc) || !isPlainObject(calc.selection)) return []
  const rows: Row[] = []
  const selection = calc.selection as Record<string, unknown>
  const pick = (key: string, label: string) => {
    const item = selection[key]
    if (isPlainObject(item) && typeof item.label === 'string' && item.label.trim()) {
      rows.push({ label, value: oneLine(item.label, 200) })
    }
  }
  const project = calc.project
  if (isPlainObject(project)) {
    const title = typeof project.article === 'string' && project.article
      ? `Проект ${project.article}`
      : typeof project.title === 'string' ? project.title : ''
    if (title) {
      const size = typeof project.size === 'string' && project.size ? ` (${project.size})` : ''
      rows.push({ label: 'Проект', value: oneLine(`${title}${size}`, 200) })
    }
  }
  pick('timber', 'Материал стен')
  pick('foundation', 'Фундамент')
  pick('roof', 'Кровля')
  const total = calc.total
  if (isPlainObject(total)) {
    if (typeof total.value === 'number' && total.value > 0) rows.push({ label: 'Итого', value: formatRub(total.value) })
    else if (total.onRequest) rows.push({ label: 'Итого', value: 'цена по запросу' })
  }
  return rows
}

/** Калькулятор сайта (fields.calc: площадь, материал, работы, итог). */
function siteCalculatorRows(calc: unknown): Row[] {
  if (!isPlainObject(calc)) return []
  const rows: Row[] = []
  for (const [key, value] of Object.entries(calc).slice(0, 12)) {
    const text = primitiveText(value)
    if (text === null) continue
    rows.push({ label: CALC_LABELS[key] || key, value: oneLine(text, 200) })
  }
  return rows
}

function utmText(utm: unknown): string {
  if (!isPlainObject(utm)) return ''
  const order = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']
  const keys = Object.keys(utm).sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
  return keys
    .map(key => {
      const value = primitiveText(utm[key])
      return value ? `${oneLine(key, 30)}=${oneLine(value, 80)}` : ''
    })
    .filter(Boolean)
    .slice(0, 8)
    .join(' · ')
}

interface LeadModel {
  brand: string
  domain: string
  name: string
  phoneDisplay: string
  phoneHref: string | null
  email: string | null
  messageText: string
  details: Row[]
  source: Row[]
  submissionRef: string
}

function buildModel(data: LeadEmailData, options: LeadEmailOptions): LeadModel {
  const fields = isPlainObject(data.fields) ? data.fields : {}
  const brand = oneLine(data.form_title, 120) || oneLine(options.fallbackTitle, 120) || 'Заявка с сайта'
  const domain = siteDomain(options.sourceUrl) || oneLine(typeof fields.site_id === 'string' ? fields.site_id : '', 80)

  const details: Row[] = []
  let messageText = ''
  if (data.message) {
    const split = splitMessage(data.message)
    details.push(...split.rows)
    messageText = split.text
  }
  const taken = new Set(details.map(row => row.label.toLowerCase()))
  const hasCalcRow = [...taken].some(label => label.startsWith('расч'))

  for (const [key, value] of Object.entries(fields)) {
    if (CONTACT_KEYS.has(key) || SOURCE_KEYS.has(key)) continue
    const text = primitiveText(value)
    if (text === null) continue
    const label = fieldLabel(key, data.field_meta)
    if (taken.has(label.toLowerCase())) continue
    taken.add(label.toLowerCase())
    details.push({ label, value: oneLine(text, 300) })
    if (details.length >= 25) break
  }

  details.push(...houseCalculatorRows(data.calculator_data))
  if (!hasCalcRow) {
    details.push(...siteCalculatorRows(fields.calc))
  }

  const source: Row[] = []
  const pageHref = safeHttpUrl(options.sourceUrl)
  if (pageHref) {
    const shown = oneLine(pageHref.replace(/^https?:\/\//, ''), 70)
    source.push({ label: 'Страница', value: pageHref, html: `<a href="${escapeEmailHtml(pageHref)}" target="_blank" style="color:#1d4ed8;text-decoration:underline;word-break:break-all;">${escapeEmailHtml(shown)}</a>` })
  }
  else if (typeof fields.page === 'string' && fields.page) {
    source.push({ label: 'Страница', value: oneLine(fields.page, 200) })
  }
  const referrer = typeof fields.referrer === 'string' ? oneLine(fields.referrer, 200) : ''
  if (referrer) source.push({ label: 'Откуда пришёл', value: referrer })
  const utm = utmText(fields.utm)
  if (utm) source.push({ label: 'UTM', value: utm })
  const device = data.device ? DEVICE_NAMES[data.device] || oneLine(data.device, 30) : ''
  if (device) source.push({ label: 'Устройство', value: device })
  source.push({ label: 'Время', value: formatMoscowTime(options.now ?? new Date()) })

  const submissionRef = options.submissionId !== undefined && options.submissionId !== null
    ? oneLine(String(options.submissionId), 64)
    : ''
  if (submissionRef) source.push({ label: 'Номер заявки', value: submissionRef.length > 12 ? submissionRef.slice(0, 8) : submissionRef })

  return {
    brand,
    domain,
    name: oneLine(data.name, 100) || 'Без имени',
    phoneDisplay: formatPhone(data.phone || ''),
    phoneHref: telHref(data.phone || ''),
    email: isStrictEmail(data.email) ? data.email : null,
    messageText: messageText.slice(0, 5000),
    details,
    source,
    submissionRef,
  }
}

// ——— Тема письма ——————————————————————————————————————————————————————

export function buildLeadSubject(data: LeadEmailData, options: Pick<LeadEmailOptions, 'fallbackTitle'> = {}): string {
  const brand = oneLine(data.form_title, 80) || oneLine(options.fallbackTitle, 80) || 'сайт'
  const name = oneLine(data.name, 60)
  // Финальный barrier: ни имя, ни form_title не протащат CR/LF/TAB в заголовок
  // Subject (header injection) — oneLine уже убрал управляющие символы.
  return oneLine(`Новая заявка — ${brand}${name ? `: ${name}` : ''}`, 160)
}

// ——— HTML ———————————————————————————————————————————————————————————

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`
const C = {
  page: '#eef1f5',
  card: '#ffffff',
  border: '#e2e8f0',
  rowBorder: '#eef2f6',
  text: '#0f172a',
  muted: '#64748b',
  faint: '#94a3b8',
  accent: '#1d4ed8',
  call: '#15803d',
  quoteBg: '#f8fafc',
  noteBg: '#fef9c3',
  noteBorder: '#fde68a',
  noteText: '#713f12',
}

function sectionTitle(title: string): string {
  return `<tr><td class="px" style="padding:22px 32px 8px 32px;font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${C.muted};">${escapeEmailHtml(title)}</td></tr>`
}

function rowsTable(rows: Row[], small = false): string {
  const size = small ? 13 : 15
  const labelSize = small ? 13 : 14
  const body = rows.map((row, index) => {
    const border = index === rows.length - 1 ? '' : `border-bottom:1px solid ${C.rowBorder};`
    const value = row.html ?? escapeEmailHtml(row.value).replace(/\n/g, '<br>')
    return `<tr>`
      + `<td class="cell-label" valign="top" width="36%" style="padding:9px 12px 9px 0;${border}font-family:${FONT};font-size:${labelSize}px;line-height:20px;color:${C.muted};">${escapeEmailHtml(row.label)}</td>`
      + `<td class="cell-value" valign="top" style="padding:9px 0;${border}font-family:${FONT};font-size:${size}px;line-height:21px;color:${C.text};word-break:break-word;">${value}</td>`
      + `</tr>`
  }).join('')
  return `<tr><td class="px" style="padding:0 32px;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${body}</table>`
    + `</td></tr>`
}

function button(href: string, label: string, bg: string, color = '#ffffff', border = bg): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn" style="border-collapse:separate;">`
    + `<tr><td align="center" bgcolor="${bg}" style="border-radius:8px;background-color:${bg};border:1px solid ${border};">`
    + `<a href="${escapeEmailHtml(href)}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:700;color:${color};text-decoration:none;border-radius:8px;">${escapeEmailHtml(label)}</a>`
    + `</td></tr></table>`
}

function attachmentsBlock(items: LeadEmailAttachment[]): string {
  if (items.length === 0) return ''
  const images = items.filter(item => item.cid)
  const files = items.filter(item => !item.cid)
  let html = sectionTitle('Вложения')
  if (images.length > 0) {
    const cells = images.slice(0, 10).map((item) => {
      const img = `<img src="cid:${escapeEmailHtml(item.cid)}" alt="${escapeEmailHtml(item.name)}" width="160" style="display:block;width:160px;max-width:100%;height:auto;border:1px solid ${C.border};border-radius:6px;">`
      const href = safeHttpUrl(item.url)
      return `<td valign="top" style="padding:0 8px 8px 0;">${href ? `<a href="${escapeEmailHtml(href)}" target="_blank">${img}</a>` : img}</td>`
    })
    const rows: string[] = []
    for (let i = 0; i < cells.length; i += 3) rows.push(`<tr>${cells.slice(i, i + 3).join('')}</tr>`)
    html += `<tr><td class="px" style="padding:0 32px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table></td></tr>`
  }
  for (const item of files.slice(0, 20)) {
    const href = safeHttpUrl(item.url)
    const link = href
      ? ` — <a href="${escapeEmailHtml(href)}" target="_blank" style="color:${C.accent};text-decoration:underline;">скачать</a>`
      : ' — во вложении к письму'
    html += `<tr><td class="px" style="padding:3px 32px;font-family:${FONT};font-size:14px;line-height:20px;color:${C.text};">${escapeEmailHtml(oneLine(item.name, 120))}${link}</td></tr>`
  }
  return html
}

export function buildLeadEmail(data: LeadEmailData, options: LeadEmailOptions): LeadEmail {
  const model = buildModel(data, options)
  const isOwner = options.audience === 'owner'
  const attachments = options.attachments ?? []
  const cmsHref = isOwner ? safeHttpUrl(options.cmsItemUrl) : null
  const routeNote = isOwner ? oneLine(options.routeNote, 400) : ''
  const subject = buildLeadSubject(data, options)

  const preheader = [model.name, model.phoneDisplay, model.messageText.slice(0, 80)].filter(Boolean).join(' · ')

  let rows = ''

  // Шапка: бренд и домен сайта.
  rows += `<tr><td class="px" style="padding:26px 32px 20px 32px;border-bottom:1px solid ${C.border};">`
    + `<div style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${C.accent};">Новая заявка с сайта</div>`
    + `<div style="padding-top:6px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:700;color:${C.text};">${escapeEmailHtml(model.brand)}</div>`
    + (model.domain ? `<div style="padding-top:2px;font-family:${FONT};font-size:14px;line-height:20px;color:${C.muted};">${escapeEmailHtml(model.domain)}</div>` : '')
    + `</td></tr>`

  if (routeNote) {
    rows += `<tr><td class="px" style="padding:16px 32px 0 32px;">`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`
      + `<td style="padding:10px 14px;background-color:${C.noteBg};border:1px solid ${C.noteBorder};border-radius:6px;font-family:${FONT};font-size:13px;line-height:19px;color:${C.noteText};">${escapeEmailHtml(routeNote)}</td>`
      + `</tr></table></td></tr>`
  }

  // Клиент: крупно имя и телефон, кнопка «Позвонить».
  rows += `<tr><td class="px" style="padding:24px 32px 4px 32px;">`
    + `<div style="font-family:${FONT};font-size:26px;line-height:32px;font-weight:700;color:${C.text};">${escapeEmailHtml(model.name)}</div>`
    + `<div style="padding-top:6px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:600;">`
    + (model.phoneHref
      ? `<a href="${escapeEmailHtml(model.phoneHref)}" style="color:${C.text};text-decoration:none;">${escapeEmailHtml(model.phoneDisplay)}</a>`
      : `<span style="color:${C.text};">${escapeEmailHtml(model.phoneDisplay)}</span>`)
    + `</div>`
    + (model.email
      ? `<div style="padding-top:4px;font-family:${FONT};font-size:15px;line-height:22px;"><a href="mailto:${escapeEmailHtml(model.email)}" style="color:${C.accent};text-decoration:underline;">${escapeEmailHtml(model.email)}</a></div>`
      : '')
    + `</td></tr>`
  if (model.phoneHref) {
    rows += `<tr><td class="px" style="padding:14px 32px 4px 32px;">${button(model.phoneHref, 'Позвонить', C.call)}</td></tr>`
  }

  if (model.messageText) {
    rows += sectionTitle('Сообщение')
    rows += `<tr><td class="px" style="padding:0 32px;">`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`
      + `<td style="padding:14px 16px;background-color:${C.quoteBg};border-left:3px solid ${C.accent};font-family:${FONT};font-size:16px;line-height:24px;color:${C.text};word-break:break-word;">${escapeEmailHtml(model.messageText).replace(/\n/g, '<br>')}</td>`
      + `</tr></table></td></tr>`
  }

  if (model.details.length > 0) {
    rows += sectionTitle('Детали заявки')
    rows += rowsTable(model.details)
  }

  rows += attachmentsBlock(attachments)

  rows += sectionTitle('Источник')
  rows += rowsTable(model.source, true)

  if (cmsHref) {
    rows += `<tr><td class="px" style="padding:24px 32px 0 32px;">${button(cmsHref, 'Открыть заявку в Directus', C.card, C.accent, C.accent)}</td></tr>`
  }

  const footer = isOwner
    ? `Письмо отправлено автоматически обработчиком заявок${model.domain ? ` для ${escapeEmailHtml(model.domain)}` : ''}.`
    : `Письмо отправлено автоматически с сайта${model.domain ? ` ${escapeEmailHtml(model.domain)}` : ''}. Перезвоните клиенту как можно скорее.`
  rows += `<tr><td class="px" style="padding:28px 32px 26px 32px;"><div style="border-top:1px solid ${C.border};padding-top:16px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.faint};">${footer}</div></td></tr>`

  const html = '<!DOCTYPE html>'
    + '<html lang="ru" xmlns="http://www.w3.org/1999/xhtml"><head>'
    + '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="x-apple-disable-message-reformatting">'
    + '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">'
    + `<title>${escapeEmailHtml(subject)}</title>`
    + '<style>'
    + 'body{margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}'
    + 'a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;}'
    + '@media only screen and (max-width:620px){'
    + '.wrap{padding:0!important;}'
    + '.card{width:100%!important;border-radius:0!important;border-left:0!important;border-right:0!important;}'
    + '.px{padding-left:18px!important;padding-right:18px!important;}'
    + '.btn,.btn td,.btn a{display:block!important;width:100%!important;box-sizing:border-box;text-align:center!important;}'
    + '.cell-label{width:40%!important;}'
    + '}'
    + '</style></head>'
    + `<body style="margin:0;padding:0;background-color:${C.page};">`
    + `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeEmailHtml(preheader)}</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.page};">`
    + `<tr><td class="wrap" align="center" style="padding:24px 12px;">`
    + '<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->'
    + `<table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:${C.card};border:1px solid ${C.border};border-radius:12px;">`
    + rows
    + '</table>'
    + '<!--[if mso]></td></tr></table><![endif]-->'
    + '</td></tr></table>'
    + '</body></html>'

  return { subject, html, text: buildText(model, { isOwner, routeNote, cmsHref, attachments }) }
}

// ——— Текстовая версия ————————————————————————————————————————————————

function buildText(
  model: LeadModel,
  extra: { isOwner: boolean, routeNote: string, cmsHref: string | null, attachments: LeadEmailAttachment[] },
): string {
  const lines: string[] = []
  lines.push(`Новая заявка с сайта: ${model.brand}${model.domain ? ` (${model.domain})` : ''}`)
  if (extra.routeNote) lines.push('', extra.routeNote)
  lines.push('', `Имя: ${model.name}`, `Телефон: ${model.phoneDisplay}`)
  if (model.email) lines.push(`Email: ${model.email}`)
  if (model.messageText) lines.push('', 'Сообщение:', model.messageText)
  if (model.details.length > 0) {
    lines.push('', 'Детали заявки:')
    for (const row of model.details) lines.push(`- ${row.label}: ${row.value}`)
  }
  if (extra.attachments.length > 0) {
    lines.push('', 'Вложения:')
    for (const item of extra.attachments) {
      const href = safeHttpUrl(item.url)
      lines.push(`- ${oneLine(item.name, 120)}${href ? ` — ${href}` : ' — во вложении к письму'}`)
    }
  }
  lines.push('', 'Источник:')
  for (const row of model.source) lines.push(`- ${row.label}: ${row.value}`)
  if (extra.cmsHref) lines.push('', `Открыть в Directus: ${extra.cmsHref}`)
  return lines.join('\n')
}
