import type { FormData } from './validation.js'
import {
  type DirectusContext,
  type ResolvedAttachment,
  escapeHtml,
  getFormTypeLabel,
  extractCustomFields,
  resolveAttachmentUrls,
  parseCalculatorData,
  formatPrice,
  DEVICE_LABELS,
  downloadFile,
  detectImageMime,
} from './shared.js'

interface MailAttachment {
  filename: string
  content: Buffer
  contentType?: string
  cid?: string
}

interface PreparedAttachment {
  attachment: ResolvedAttachment
  mail: MailAttachment
  cid?: string
}

interface EmailSettings {
  host: string
  port: number
  secure: boolean
  user: string
  password: string
  from: string
  to: string
  cmsDomain: string
  source: 'db' | 'env'
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Валидирует адрес(а) из email_settings: запрет CR/LF (header injection через
 * from/to) + базовая форма адреса. email_to может содержать список через запятую —
 * валидируем каждый. Возвращает нормализованную строку или null если невалидно.
 */
function sanitizeEmailField(value: unknown, label: string): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (/[\r\n]/.test(trimmed)) {
    console.warn(`[forms-handler] email_settings.${label} содержит CR/LF — отброшено`)
    return null
  }
  const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length === 0 || !parts.every(p => EMAIL_RE.test(p))) {
    console.warn(`[forms-handler] email_settings.${label} невалидный формат: ${trimmed}`)
    return null
  }
  return parts.join(', ')
}

/**
 * Load email settings from Directus `email_settings` singleton collection.
 * Falls back to env variables (FORM_EMAIL_TO) for backwards compatibility.
 */
async function loadEmailSettings(directusContext?: DirectusContext): Promise<EmailSettings | null> {
  // 1. Try loading from Directus collection
  if (directusContext) {
    try {
      const schema = await directusContext.getSchema()
      const { ItemsService } = directusContext.services
      const service = new ItemsService('email_settings', {
        schema,
        accountability: { admin: true },
      })

      // Контракт платформы (DIRECTUS-SEEDS §1): в БД — маршрутизация
      // (enabled/from_name/from_email/to_emails), SMTP-креды — ТОЛЬКО в env.
      const settings = await service.readSingleton({
        fields: ['enabled', 'from_name', 'from_email', 'to_emails'],
      })

      if (settings?.enabled && settings?.to_emails) {
        const toRaw = Array.isArray(settings.to_emails)
          ? settings.to_emails.join(',')
          : String(settings.to_emails)
        const to = sanitizeEmailField(toRaw, 'to_emails')
        const from = sanitizeEmailField(settings.from_email, 'from_email')
          ?? sanitizeEmailField(process.env.EMAIL_FROM || '', 'EMAIL_FROM')
        if (!to) {
          console.error('[forms-handler] email_settings.to_emails невалиден — email отключён')
          return null
        }
        return {
          host: process.env.EMAIL_SMTP_HOST || '',
          port: Number(process.env.EMAIL_SMTP_PORT) || 587,
          secure: process.env.EMAIL_SMTP_SECURE === 'true',
          user: process.env.EMAIL_SMTP_USER || '',
          password: process.env.EMAIL_SMTP_PASSWORD || '',
          from: from || process.env.EMAIL_SMTP_USER || '',
          to,
          cmsDomain: process.env.CMS_DOMAIN || '',
          source: 'db',
        }
      }

      if (settings && !settings.enabled) {
        console.log('[forms-handler] Email disabled in email_settings')
        return null
      }
    }
    catch (err: any) {
      // Collection might not exist yet — fall through to env
      if (err?.status !== 403 && err?.code !== 'FORBIDDEN') {
        console.warn('[forms-handler] Could not read email_settings, falling back to env:', err?.message || err)
      }
    }
  }

  // 2. Fallback: env variables (backwards compatibility)
  const emailTo = process.env.FORM_EMAIL_TO || ''
  if (!emailTo) return null

  return {
    host: '',
    port: 587,
    secure: false,
    user: '',
    password: '',
    from: '',
    to: emailTo,
    cmsDomain: process.env.CMS_DOMAIN || '',
    source: 'env',
  }
}

function getCmsUrl(cmsDomain?: string): string {
  const domain = cmsDomain || process.env.CMS_DOMAIN || ''
  if (!domain) return ''
  return `https://${domain}`
}

function buildEmailSubject(data: FormData): string {
  const typeLabel = getFormTypeLabel(data)
  const name = data.name ? ` — ${data.name}` : ''
  // Финальный barrier: ни client-name, ни client form_title/form_key не должны
  // протащить CR/LF/TAB в SMTP-заголовок Subject (header injection).
  return `Новая заявка: ${typeLabel}${name}`.replace(/[\r\n\t]+/g, ' ').trim()
}

function formatDate(): string {
  const now = new Date()
  const months = [
    'янв', 'фев', 'мар', 'апр', 'май', 'июн',
    'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
  ]
  return `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`
}

// ——— HTML email template (table-based, inline CSS, Outlook-compatible) ———

const FONT_STACK = "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
const COLOR_PRIMARY = '#3B82F6'
const COLOR_TEXT = '#303242'
const COLOR_MUTED = '#6b7280'
const COLOR_BG = '#f4f5f7'
const COLOR_CARD = '#ffffff'
const COLOR_BORDER = '#e5e7eb'

function sectionHeading(text: string): string {
  return `<tr><td style="padding:16px 24px 8px 24px;font-family:${FONT_STACK};font-size:13px;font-weight:600;color:${COLOR_MUTED};text-transform:uppercase;letter-spacing:0.5px;">${text}</td></tr>`
}

function fieldRow(label: string, value: string): string {
  return `<tr><td style="padding:4px 24px;font-family:${FONT_STACK};font-size:15px;color:${COLOR_TEXT};line-height:1.5;"><strong style="color:${COLOR_MUTED};">${label}:</strong> ${value}</td></tr>`
}

function divider(): string {
  return `<tr><td style="padding:8px 24px;"><hr style="border:none;border-top:1px solid ${COLOR_BORDER};margin:0;" /></td></tr>`
}

function buildContactsSection(data: FormData): string {
  let rows = ''
  rows += fieldRow('Имя', escapeHtml(data.name))
  rows += fieldRow('Телефон', escapeHtml(data.phone))
  if (data.email) {
    rows += fieldRow('Email', `<a href="mailto:${escapeHtml(data.email)}" style="color:${COLOR_PRIMARY};text-decoration:none;">${escapeHtml(data.email)}</a>`)
  }
  return sectionHeading('Контакты') + rows
}

function buildMessageSection(data: FormData): string {
  if (!data.message) return ''

  const escapedMessage = escapeHtml(data.message).replace(/\n/g, '<br />')

  return divider()
    + sectionHeading('Сообщение')
    + `<tr><td style="padding:4px 24px 8px;font-family:${FONT_STACK};font-size:15px;color:${COLOR_TEXT};line-height:1.6;">${escapedMessage}</td></tr>`
}

function buildCustomFieldsSection(data: FormData): string {
  const fields = extractCustomFields(data)
  if (fields.length === 0) return ''

  let rows = ''
  for (const { label, value } of fields) {
    rows += fieldRow(label, escapeHtml(value))
  }

  return divider() + sectionHeading('Поля формы') + rows
}

function buildAttachmentsSection(prepared: PreparedAttachment[]): string {
  if (prepared.length === 0) return ''

  const images = prepared.filter(item => item.cid)
  const others = prepared.filter(item => !item.cid)

  let rows = ''

  if (images.length > 0) {
    let imgCells = ''
    for (const item of images) {
      imgCells +=
        `<td style="padding:6px;vertical-align:top;" valign="top">` +
        `<a href="${escapeHtml(item.attachment.url)}" target="_blank" style="text-decoration:none;">` +
        `<img src="cid:${item.cid}" alt="${escapeHtml(item.attachment.name)}" ` +
        `style="display:block;max-width:260px;width:100%;height:auto;border-radius:8px;border:1px solid ${COLOR_BORDER};" />` +
        `</a>` +
        `</td>`
    }
    rows +=
      `<tr><td style="padding:4px 18px 8px;">` +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${imgCells}</tr></table>` +
      `</td></tr>`
  }

  for (const item of others) {
    rows +=
      `<tr><td style="padding:4px 24px;font-family:${FONT_STACK};font-size:14px;color:${COLOR_TEXT};line-height:1.5;">` +
      `&#x1F4CE; ${escapeHtml(item.attachment.name)} &mdash; ` +
      `<a href="${escapeHtml(item.attachment.url)}" style="color:${COLOR_PRIMARY};text-decoration:none;" target="_blank">Скачать</a>` +
      `</td></tr>`
  }

  return divider() + sectionHeading('Вложения') + rows
}

function buildCalculatorSection(data: FormData): string {
  const calc = parseCalculatorData(data)
  if (!calc) return ''

  let rows = ''
  const sel = calc.selection
  if (sel.timber?.label) rows += fieldRow('Материал стен', escapeHtml(sel.timber.label))
  if (sel.foundation?.label) rows += fieldRow('Фундамент', escapeHtml(sel.foundation.label))
  if (sel.roof?.label) rows += fieldRow('Кровля', escapeHtml(sel.roof.label))

  if (calc.total?.value && calc.total.value > 0) {
    rows += `<tr><td style="padding:8px 24px;font-family:${FONT_STACK};font-size:18px;font-weight:700;color:${COLOR_TEXT};line-height:1.5;">` +
      `&#x1F4B0; Итого: ${formatPrice(calc.total.value)} &#x20BD;` +
      `</td></tr>`
  }
  if (calc.total?.onRequest) {
    rows += `<tr><td style="padding:2px 24px;font-family:${FONT_STACK};font-size:13px;color:${COLOR_MUTED};font-style:italic;">(Точная цена по запросу)</td></tr>`
  }

  return divider() + sectionHeading('Параметры расчета') + rows
}

function buildProjectSection(data: FormData, sourceUrl?: string): string {
  const calc = parseCalculatorData(data)
  if (!calc?.project) return ''

  const project = calc.project
  const label = project.article
    ? `Проект ${project.article}`
    : project.title || ''
  const size = project.size ? ` (${project.size})` : ''
  if (!label) return ''

  const text = `${escapeHtml(label)}${escapeHtml(size)}`
  const link = sourceUrl
    ? `<a href="${escapeHtml(sourceUrl)}" style="color:${COLOR_PRIMARY};text-decoration:none;font-weight:600;" target="_blank">${text}</a>`
    : `<strong>${text}</strong>`

  return divider()
    + `<tr><td style="padding:12px 24px;font-family:${FONT_STACK};font-size:15px;color:${COLOR_TEXT};line-height:1.5;">` +
    `&#x1F3E0; ${link}` +
    `</td></tr>`
}

function buildSourceSection(sourceUrl?: string): string {
  if (!sourceUrl) return ''

  return divider()
    + `<tr><td style="padding:12px 24px;font-family:${FONT_STACK};font-size:14px;color:${COLOR_MUTED};line-height:1.5;">` +
    `&#x1F517; Страница: <a href="${escapeHtml(sourceUrl)}" style="color:${COLOR_PRIMARY};text-decoration:none;" target="_blank">${escapeHtml(sourceUrl)}</a>` +
    `</td></tr>`
}

function buildCtaButton(submissionId: string, cmsDomain?: string): string {
  const cmsUrl = getCmsUrl(cmsDomain)
  if (!cmsUrl) return ''

  const collection = process.env.FORMS_COLLECTION || 'lead_submissions'
  const url = `${cmsUrl}/admin/content/${collection}/${submissionId}`

  // Table-based button pattern for Outlook compatibility
  return `<tr><td style="padding:20px 24px 8px;" align="center">` +
    `<table border="0" cellpadding="0" cellspacing="0" role="presentation"><tr>` +
    `<td style="border-radius:8px;background-color:${COLOR_PRIMARY};">` +
    `<a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:12px 28px;font-family:${FONT_STACK};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">Открыть в Directus</a>` +
    `</td></tr></table>` +
    `</td></tr>`
}

function buildFooterSection(data: FormData): string {
  const date = formatDate()
  const parts: string[] = []
  if (data.device) {
    const deviceLabel = DEVICE_LABELS[data.device] || data.device
    const cleanLabel = deviceLabel.replace(/[\u{1F4F1}\u{1F4BB}]\s*/gu, '')
    parts.push(escapeHtml(cleanLabel))
  }
  parts.push(escapeHtml(date))

  return `<tr><td style="padding:16px 24px 20px;border-top:1px solid ${COLOR_BORDER};">` +
    `<p style="margin:0;font-family:${FONT_STACK};font-size:12px;color:${COLOR_MUTED};line-height:1.5;text-align:center;">` +
    `${parts.join(' &bull; ')}` +
    `</p></td></tr>`
}

function buildEmailHtml(
  data: FormData,
  submissionId: string,
  sourceUrl?: string,
  attachments: PreparedAttachment[] = [],
  cmsDomain?: string,
): string {
  const typeLabel = getFormTypeLabel(data)
  const calc = parseCalculatorData(data)

  const header = `<tr><td style="background-color:${COLOR_PRIMARY};padding:24px 24px 20px;border-radius:12px 12px 0 0;">` +
    `<h1 style="margin:0;font-family:${FONT_STACK};font-size:20px;font-weight:700;color:#ffffff;line-height:1.3;">Новая заявка: ${escapeHtml(typeLabel)}</h1>` +
    `</td></tr>`

  const contacts = buildContactsSection(data)
  const cta = buildCtaButton(submissionId, cmsDomain)
  const footer = buildFooterSection(data)

  let body = ''
  if (calc) {
    // Calculator form: params + price + project link
    body += buildCalculatorSection(data)
    body += buildProjectSection(data, sourceUrl)
    body += buildAttachmentsSection(attachments)
  }
  else {
    // Regular form: message + custom fields + attachments + source
    body += buildMessageSection(data)
    body += buildCustomFieldsSection(data)
    body += buildAttachmentsSection(attachments)
    body += buildSourceSection(sourceUrl)
  }

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">` +
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0" />` +
    `<title>Новая заявка</title></head>` +
    `<body style="margin:0;padding:0;background-color:${COLOR_BG};">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLOR_BG};">` +
    `<tr><td align="center" style="padding:24px 16px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:${COLOR_CARD};border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">` +
    header +
    contacts +
    body +
    cta +
    footer +
    `</table>` +
    `</td></tr></table>` +
    `</body></html>`
}

export async function sendEmailNotification(
  data: FormData,
  submissionId: string,
  sourceUrl?: string,
  directusContext?: DirectusContext,
): Promise<boolean> {
  if (!directusContext) {
    console.warn('[forms-handler] No Directus context, cannot send email')
    return false
  }

  const settings = await loadEmailSettings(directusContext)

  if (!settings) {
    console.log('[forms-handler] Email not configured (disabled or no settings)')
    return false
  }

  try {
    // Resolve attachment URLs + download files to attach directly to email
    const resolved = await resolveAttachmentUrls(data.attachments, directusContext)
    const prepared: PreparedAttachment[] = []
    let imageCidCounter = 0

    for (const att of resolved) {
      const buffer = await downloadFile(att.url)
      if (!buffer) continue

      // Тип определяем по magic-bytes, а не по client-declared mimeType:
      // PDF с заявленным image/jpeg иначе встроился бы как cid:image в HTML
      // (битая «картинка» в письме) — и доверять mime получателя на той стороне
      // тоже нельзя. Если magic-bytes сказали "не картинка" — обычное вложение.
      const realImageMime = detectImageMime(buffer)
      const cid = realImageMime ? `form-image-${submissionId}-${imageCidCounter++}` : undefined

      prepared.push({
        attachment: att,
        cid,
        mail: {
          filename: att.name,
          content: buffer,
          contentType: realImageMime ?? att.mimeType,
          ...(cid ? { cid } : {}),
        },
      })
    }

    const subject = buildEmailSubject(data)
    const html = buildEmailHtml(data, submissionId, sourceUrl, prepared, settings.cmsDomain)
    const mailAttachments = prepared.map(item => item.mail)

    if (settings.source === 'db') {
      // New path: send via nodemailer with DB settings
      const nodemailer = await import('nodemailer')
      const transporter = nodemailer.createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        auth: {
          user: settings.user,
          pass: settings.password,
        },
      })

      await transporter.sendMail({
        from: settings.from,
        to: settings.to,
        subject,
        html,
        attachments: mailAttachments,
      })
    }
    else {
      // Legacy path: send via Directus MailService (env-based SMTP)
      if (mailAttachments.length > 0) {
        console.warn('[forms-handler] Legacy MailService path may not forward attachments. Configure email_settings in Directus for reliable inline attachments.')
      }
      const schema = await directusContext.getSchema()
      const { MailService } = directusContext.services
      const mailService = new MailService({ schema })

      await mailService.send({
        to: settings.to,
        subject,
        html,
        attachments: mailAttachments,
      })
    }

    console.log(`[forms-handler] Email sent to ${settings.to} via ${settings.source} for submission ${submissionId} (attachments: ${mailAttachments.length})`)
    return true
  }
  catch (error) {
    console.error('[forms-handler] Failed to send email notification:', error)
    return false
  }
}
