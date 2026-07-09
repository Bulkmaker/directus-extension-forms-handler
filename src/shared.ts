import type { FormData } from './validation.js'

export interface DirectusContext {
  services: any
  getSchema: () => Promise<any>
}

export const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

export function isImageMimeType(mimeType?: string): boolean {
  if (!mimeType) return false
  return IMAGE_MIME_TYPES.has(mimeType.toLowerCase())
}

export function getPublicFilesUrl(): string {
  return process.env.PUBLIC_FILES_URL || process.env.NUXT_PUBLIC_FILES_URL || ''
}

let allowedHostsCache: Set<string> | null = null
let allowedHostsCachedFor = ''

function getAllowedDownloadHosts(): Set<string> {
  const url = getPublicFilesUrl()
  if (allowedHostsCache === null || url !== allowedHostsCachedFor) {
    allowedHostsCachedFor = url
    try {
      allowedHostsCache = url ? new Set([new URL(url).hostname]) : new Set()
    }
    catch {
      allowedHostsCache = new Set()
    }
  }
  return allowedHostsCache
}

export function getClientIp(req: {
  headers: Record<string, unknown>
  socket?: { remoteAddress?: string }
}): string {
  // Traefik проставляет X-Real-IP = реальный клиентский адрес (trusted proxy).
  // Доверяем ему как первичному источнику — он не контролируется клиентом,
  // т.к. Traefik перезаписывает заголовок на входе. Это и есть стабильный
  // identifier для rate-limit/honeypot (его нельзя подменить спуфингом XFF).
  const realIp = req.headers['x-real-ip']
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim()
  }

  // Фоллбэк: последний элемент XFF (его ставит trusted proxy при аппенде).
  const forwarded = req.headers['x-forwarded-for']
  const forwardedValues = Array.isArray(forwarded)
    ? forwarded.map(v => String(v))
    : typeof forwarded === 'string' ? forwarded.split(',') : null

  if (forwardedValues?.length) {
    const chain = forwardedValues
      .flatMap(value => value.split(','))
      .map(value => value.trim())
      .filter(Boolean)

    // X-Forwarded-For: «client, proxy1, proxy2». Первый элемент атакующий
    // контролирует через спуфинг (`curl -H 'X-Forwarded-For: ...'` → reverse-proxy
    // добавит реальный IP в конец). Последний элемент ставит trusted proxy
    // (Traefik/nginx).
    if (chain.length > 0) {
      return chain[chain.length - 1]!
    }
  }

  return req.socket?.remoteAddress || 'unknown'
}

/**
 * Detect image MIME by magic bytes (not by client-declared header).
 * Defends against attachments that claim to be images but actually aren't —
 * those would otherwise be uploaded to VK photos API or inlined into emails.
 */
export function detectImageMime(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | null {
  if (buf.length < 12) return null
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg'
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A
  ) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'image/webp'
  return null
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function formatUnknownValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    if (value.length <= 4) return value.map(item => formatUnknownValue(item)).join(', ')
    return `${value.slice(0, 4).map(item => formatUnknownValue(item)).join(', ')} (+${value.length - 4})`
  }
  try {
    const json = JSON.stringify(value)
    return json.length > 200 ? `${json.slice(0, 200)}…` : json
  }
  catch {
    return '[сложное значение]'
  }
}

export const TYPE_LABELS: Record<string, string> = {
  contact: 'Контактная форма',
  calculator: 'Расчет проекта',
  delivery: 'Форма доставки',
}

export const DEVICE_LABELS: Record<string, string> = {
  mobile: '📱 Телефон',
  tablet: '📱 Планшет',
  desktop: '💻 Компьютер',
}

export function getFormTypeLabel(data: FormData): string {
  return TYPE_LABELS[data.type] || data.form_title || data.form_key || data.type
}

/** Known/technical fields excluded from custom fields display */
const KNOWN_FIELDS = new Set([
  'name',
  'client_name',
  'phone',
  'client_phone',
  'email',
  'client_email',
  'message',
  'request_message',
  'estimate_summary',
  'estimate_payload',
  'agree',
  'privacy_consent',
  'calculator_data',
  'calculator_payload',
  'source_path',
  'project_slug',
  'project_attachments',
])

export interface FieldEntry {
  key: string
  label: string
  value: string
}

function isPlainObjectValue(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Extract custom fields with labels from field_meta.
 * Skips known/technical fields (name, phone, email, message, etc.) and
 * plain-object values (e.g. calculator project/selection payloads) — those
 * have no readable one-line rendering and just dump raw JSON into
 * notifications; the calculator branch already renders them properly.
 */
export function extractCustomFields(data: FormData, maxFields = 15): FieldEntry[] {
  const entries = Object.entries(data.fields || {})
    .filter(([key]) => !KNOWN_FIELDS.has(key))
    .filter(([, value]) => !isPlainObjectValue(value))
  if (entries.length === 0) return []

  const fieldMeta = data.field_meta || {}

  return entries.slice(0, maxFields).map(([key, value]) => {
    const meta = fieldMeta[key]
    const label = typeof meta === 'object' && meta !== null
      ? (meta as { label?: string }).label || key
      : key
    return { key, label, value: formatUnknownValue(value) }
  })
}

export interface MessageRow {
  label: string
  value: string
}

export interface SplitMessage {
  rows: MessageRow[]
  extra: string[]
}

const LABEL_LINE_RE = /^([^:\n]{1,60}):\s*(.+)$/

/**
 * Split a free-text form message into "Label: value" rows (rendered as a
 * table by the caller) plus any non-tabular lines (e.g. a trailing comment
 * without a label, or a parenthetical note). Forms like the project
 * calculator build their `message` this way (see CalcInlineForm.jsx) —
 * splitting it back out avoids re-sending the same data twice as a separate
 * raw "fields" dump.
 */
export function splitLabeledMessage(message: string): SplitMessage {
  const rows: MessageRow[] = []
  const extra: string[] = []

  for (const rawLine of message.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const match = LABEL_LINE_RE.exec(line)
    if (match) {
      rows.push({ label: match[1].trim(), value: match[2].trim() })
    }
    else {
      extra.push(line)
    }
  }

  return { rows, extra }
}

// ——— Calculator data parsing ———

export interface CalculatorProject {
  id?: number
  title?: string
  slug?: string
  article?: string
  size?: string
}

export interface CalculatorSelection {
  timber?: { label?: string; price?: number }
  foundation?: { label?: string; price?: number }
  roof?: { label?: string; price?: number }
}

export interface CalculatorTotal {
  value?: number
  onRequest?: boolean
}

export interface ParsedCalculatorData {
  project?: CalculatorProject
  selection: CalculatorSelection
  total?: CalculatorTotal
}

export function parseCalculatorData(data: FormData): ParsedCalculatorData | null {
  const raw = data.calculator_data
  if (!raw || typeof raw !== 'object') return null
  const cd = raw as Record<string, unknown>
  if (!cd.selection || typeof cd.selection !== 'object') return null
  return raw as unknown as ParsedCalculatorData
}

export function formatPrice(value: number): string {
  return new Intl.NumberFormat('ru-RU').format(value)
}

export function formatShortDate(): string {
  const now = new Date()
  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
  return `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`
}

export interface ResolvedAttachment {
  name: string
  url: string
  mimeType?: string
}

export const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024

export async function downloadFile(url: string): Promise<Buffer | null> {
  // SSRF guard: разрешаем скачивание только с PUBLIC_FILES_URL host'а.
  // Без этого fetch ходил бы по любому URL, что опасно если в директорию
  // directus_files когда-нибудь попадёт строка с произвольным абсолютным URL,
  // либо если PUBLIC_FILES_URL ошибочно укажет на internal-адрес.
  let parsed: URL
  try {
    parsed = new URL(url)
  }
  catch {
    console.error(`[forms-handler] downloadFile: invalid URL: ${url}`)
    return null
  }

  const allowed = getAllowedDownloadHosts()
  if (!allowed.has(parsed.hostname)) {
    console.error(`[forms-handler] downloadFile: blocked download from disallowed host: ${parsed.hostname}`)
    return null
  }

  try {
    const response = await fetch(url)
    if (!response.ok) {
      console.error(`[forms-handler] Failed to download ${url}: HTTP ${response.status}`)
      return null
    }
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > MAX_DOWNLOAD_BYTES) {
      console.warn(`[forms-handler] Skipping ${url}: declared ${declared} bytes exceeds ${MAX_DOWNLOAD_BYTES} limit`)
      return null
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_DOWNLOAD_BYTES) {
      console.warn(`[forms-handler] Skipping ${url}: downloaded ${buffer.length} bytes exceeds ${MAX_DOWNLOAD_BYTES} limit`)
      return null
    }
    return buffer
  }
  catch (err) {
    console.error(`[forms-handler] Failed to download ${url}:`, err)
    return null
  }
}

/**
 * Resolve public URLs for uploaded attachments.
 * Queries directus_files to get filename_disk, then builds S3 URL.
 */
export async function resolveAttachmentUrls(
  attachments: FormData['attachments'],
  directusContext?: DirectusContext,
): Promise<ResolvedAttachment[]> {
  const publicFilesUrl = getPublicFilesUrl()
  if (!publicFilesUrl) {
    console.warn('[forms-handler] PUBLIC_FILES_URL not set, cannot resolve attachment URLs')
    return []
  }

  const uploaded = attachments.filter(
    item => item.status !== 'failed' && item.id,
  )

  if (uploaded.length === 0) return []

  if (!directusContext) {
    console.warn('[forms-handler] No Directus context, cannot resolve attachment URLs')
    return []
  }

  const results: ResolvedAttachment[] = []

  try {
    const schema = await directusContext.getSchema()
    const { ItemsService } = directusContext.services
    const filesService = new ItemsService('directus_files', {
      schema,
      accountability: { admin: true },
    })

    for (const attachment of uploaded.slice(0, 10)) {
      try {
        const file = await filesService.readOne(attachment.id, { fields: ['filename_disk'] })
        if (file?.filename_disk) {
          results.push({
            name: attachment.name,
            url: `${publicFilesUrl}/${file.filename_disk}`,
            mimeType: attachment.mimeType,
          })
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

  return results
}
