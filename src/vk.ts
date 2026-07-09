import type { FormData } from './validation.js'
import {
  type DirectusContext,
  type ResolvedAttachment,
  extractCustomFields,
  getFormTypeLabel,
  parseCalculatorData,
  formatPrice,
  formatShortDate,
  DEVICE_LABELS,
  isImageMimeType,
  resolveAttachmentUrls,
  downloadFile,
  detectImageMime,
} from './shared.js'

/**
 * Логировать ТОЛЬКО error_code + error_msg, не весь VK error-объект.
 * VK при auth-ошибках возвращает request_params с access_token в plaintext —
 * без этой обёртки токен утекал бы в container logs.
 */
function formatVkError(err: VkApiError | undefined): string {
  if (!err) return 'unknown error'
  const code = err.error_code ?? '?'
  const msg = err.error_msg || 'no message'
  return `code=${code} msg=${msg}`
}

interface VkConfig {
  botToken: string
  peerIds: number[]
}

export interface VkNotificationResult {
  sent: boolean
}

interface VkApiError {
  error_code?: number
  error_msg?: string
}

function loadVkConfig(): VkConfig {
  const peerIds = new Set<number>()

  for (const value of [process.env.VK_ADMIN_IDS, process.env.VK_CLIENT_IDS]) {
    if (!value) continue

    value.split(',').forEach((id) => {
      const parsed = Number.parseInt(id.trim(), 10)
      if (Number.isFinite(parsed)) {
        peerIds.add(parsed)
      }
    })
  }

  return {
    botToken: process.env.VK_GROUP_TOKEN || '',
    peerIds: [...peerIds],
  }
}

function buildFieldsBlock(data: FormData): string {
  const fields = extractCustomFields(data)
  if (fields.length === 0) return ''

  return fields
    .map(({ label, value }) => `• ${label}: ${value}`)
    .join('\n')
}

function buildAttachmentsBlock(
  resolvedAttachments: ResolvedAttachment[],
  failedAttachments: FormData['attachments'],
): string {
  const lines: string[] = []

  if (resolvedAttachments.length > 0) {
    lines.push('📎 Вложения:')
    resolvedAttachments.slice(0, 8).forEach((attachment) => {
      lines.push(`• ${attachment.name} — ${attachment.url}`)
    })
  }

  const failed = failedAttachments.filter(item => item.status === 'failed')
  if (failed.length > 0) {
    lines.push('⚠️ Не загружены:')
    failed.slice(0, 8).forEach((attachment) => {
      const suffix = attachment.reason ? ` — ${attachment.reason}` : ''
      lines.push(`• ${attachment.name}${suffix}`)
    })
  }

  return lines.join('\n')
}

function formatMessage(
  data: FormData,
  sourceUrl?: string,
  attachmentsBlock = '',
): string {
  const typeLabel = getFormTypeLabel(data)
  const calc = parseCalculatorData(data)

  const lines: string[] = [
    `Новая заявка: ${typeLabel}`,
    '',
    `👤 Имя: ${data.name}`,
    `📞 Телефон: ${data.phone}`,
  ]

  if (data.email) {
    lines.push(`📧 Email: ${data.email}`)
  }

  if (calc) {
    const selection = calc.selection
    lines.push('', '📐 Параметры:')

    if (selection.timber?.label) lines.push(`• Материал стен: ${selection.timber.label}`)
    if (selection.foundation?.label) lines.push(`• Фундамент: ${selection.foundation.label}`)
    if (selection.roof?.label) lines.push(`• Кровля: ${selection.roof.label}`)

    if (calc.total?.value && calc.total.value > 0) {
      lines.push('', `💰 Итого: ${formatPrice(calc.total.value)} ₽`)
    }
    if (calc.total?.onRequest) {
      lines.push('(Точная цена по запросу)')
    }

    const project = calc.project
    if (project) {
      const label = project.article
        ? `Проект ${project.article}`
        : project.title || ''
      const size = project.size ? ` (${project.size})` : ''
      if (label) {
        lines.push('', `🏠 ${label}${size}`)
        if (sourceUrl) {
          lines.push(`🔗 ${sourceUrl}`)
        }
      }
    }
  }
  else {
    if (data.message) {
      lines.push('', '💬 Сообщение:', data.message)
    }

    const fieldsBlock = buildFieldsBlock(data)
    if (fieldsBlock) {
      lines.push('', '🗂 Поля формы:', fieldsBlock)
    }

    if (attachmentsBlock) {
      lines.push('', attachmentsBlock)
    }

    if (sourceUrl) {
      lines.push('', `🔗 Страница: ${sourceUrl}`)
    }
  }

  const footerParts: string[] = []
  if (data.device) {
    footerParts.push(DEVICE_LABELS[data.device] || data.device)
  }
  footerParts.push(formatShortDate())
  lines.push('', footerParts.join(' • '))

  const message = lines.join('\n')
  return message.length > 3900 ? `${message.slice(0, 3890)}\n…` : message
}

async function callVkApi(
  config: VkConfig,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; response: any } | { ok: false; error: VkApiError }> {
  const body = new URLSearchParams({
    access_token: config.botToken,
    v: '5.199',
  })

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue

    if (typeof value === 'string') {
      body.set(key, value)
      continue
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      body.set(key, String(value))
      continue
    }

    body.set(key, JSON.stringify(value))
  }

  const response = await fetch(`https://api.vk.com/method/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  const payload = await response.json() as { response?: any; error?: VkApiError }

  if (payload.error) {
    return { ok: false, error: payload.error }
  }

  return { ok: true, response: payload.response }
}

async function uploadPhotoForPeer(
  config: VkConfig,
  peerId: number,
  photoBuffer: Buffer,
  filename: string,
  mimeType?: string,
): Promise<string | null> {
  const serverResult = await callVkApi(config, 'photos.getMessagesUploadServer', { peer_id: peerId })
  if (!serverResult.ok) {
    console.error(`[forms-handler] VK photos.getMessagesUploadServer error (peer ${peerId}): ${formatVkError(serverResult.error)}`)
    return null
  }

  const uploadUrl = (serverResult.response as { upload_url?: string } | undefined)?.upload_url
  if (!uploadUrl) {
    console.error(`[forms-handler] VK upload_url missing in response (peer ${peerId})`)
    return null
  }

  const form = new FormData()
  form.append('photo', new Blob([photoBuffer], { type: mimeType || 'image/jpeg' }), filename)

  let uploadData: { server?: number, photo?: string, hash?: string }
  try {
    const uploadResp = await fetch(uploadUrl, { method: 'POST', body: form })
    if (!uploadResp.ok) {
      console.error(`[forms-handler] VK photo upload HTTP ${uploadResp.status}`)
      return null
    }
    uploadData = await uploadResp.json() as { server?: number, photo?: string, hash?: string }
  }
  catch (err) {
    console.error(`[forms-handler] VK photo upload failed:`, err)
    return null
  }

  if (uploadData.server === undefined || !uploadData.photo || !uploadData.hash) {
    console.error(`[forms-handler] VK upload response invalid:`, uploadData)
    return null
  }

  const saveResult = await callVkApi(config, 'photos.saveMessagesPhoto', {
    server: uploadData.server,
    photo: uploadData.photo,
    hash: uploadData.hash,
  })
  if (!saveResult.ok) {
    console.error(`[forms-handler] VK photos.saveMessagesPhoto error: ${formatVkError(saveResult.error)}`)
    return null
  }

  const saved = Array.isArray(saveResult.response)
    ? saveResult.response[0] as { owner_id?: number, id?: number, access_key?: string } | undefined
    : undefined

  if (!saved || saved.owner_id === undefined || saved.id === undefined) {
    console.error(`[forms-handler] VK saveMessagesPhoto response invalid:`, saveResult.response)
    return null
  }

  const accessKeyPart = saved.access_key ? `_${saved.access_key}` : ''
  return `photo${saved.owner_id}_${saved.id}${accessKeyPart}`
}

async function sendToPeer(
  config: VkConfig,
  peerId: number,
  message: string,
  attachments: string[] = [],
): Promise<boolean> {
  const result = await callVkApi(config, 'messages.send', {
    peer_ids: peerId,
    random_id: Date.now() + peerId,
    message,
    attachment: attachments.length > 0 ? attachments.join(',') : undefined,
    dont_parse_links: 1,
  })

  if (!result.ok) {
    console.error(`[forms-handler] VK messages.send error (peer ${peerId}): ${formatVkError(result.error)}`)
    return false
  }

  return true
}

export async function sendVkNotification(
  data: FormData,
  submissionId: string,
  sourceUrl?: string,
  directusContext?: DirectusContext,
): Promise<VkNotificationResult> {
  const config = loadVkConfig()

  if (!config.botToken || config.peerIds.length === 0) {
    console.log('[forms-handler] VK not configured (missing VK_GROUP_TOKEN or peer IDs)')
    return { sent: false }
  }

  try {
    const resolved = await resolveAttachmentUrls(data.attachments, directusContext)
    const declaredImages = resolved.filter(item => isImageMimeType(item.mimeType)).slice(0, 10)
    const declaredNonImages = resolved.filter(item => !isImageMimeType(item.mimeType))

    // Скачать заявленные images и верифицировать magic-bytes. Те что не прошли —
    // в text-link fallback вместе с не-image attachments. Это блокирует ситуацию
    // когда клиент шлёт PDF/ZIP с mimeType=image/jpeg → VK photos API получает
    // мусор, ловит rate-limit/блокировку токена.
    const photoBuffers = new Map<string, { buffer: Buffer, name: string, mimeType: string }>()
    const verifiedImages: ResolvedAttachment[] = []
    const fakeImages: ResolvedAttachment[] = []
    for (const image of declaredImages) {
      const buffer = await downloadFile(image.url)
      if (!buffer) continue
      const realMime = detectImageMime(buffer)
      if (!realMime) {
        console.warn(`[forms-handler] Attachment ${image.name}: declared as image but magic-bytes don't match — falling back to text link`)
        fakeImages.push(image)
        continue
      }
      photoBuffers.set(image.url, { buffer, name: image.name, mimeType: realMime })
      verifiedImages.push(image)
    }

    const nonImagesForMessage = [...declaredNonImages, ...fakeImages]
    const attachmentsBlock = buildAttachmentsBlock(nonImagesForMessage, data.attachments)
    const message = formatMessage(data, sourceUrl, attachmentsBlock)

    let anySent = false

    for (const peerId of config.peerIds) {
      try {
        const attachmentStrings: string[] = []
        for (const image of verifiedImages) {
          const entry = photoBuffers.get(image.url)
          if (!entry) continue
          const att = await uploadPhotoForPeer(config, peerId, entry.buffer, entry.name, entry.mimeType)
          if (att) attachmentStrings.push(att)
        }

        let finalMessage = message
        if (verifiedImages.length > 0 && attachmentStrings.length === 0) {
          console.warn(`[forms-handler] VK peer ${peerId}: all ${verifiedImages.length} image upload(s) failed, appending text links`)
          const fallbackLines = ['', '🖼 Изображения (не удалось прикрепить):']
          for (const image of verifiedImages) {
            fallbackLines.push(`• ${image.name} — ${image.url}`)
          }
          finalMessage = `${message}\n${fallbackLines.join('\n')}`
          if (finalMessage.length > 3900) {
            finalMessage = `${finalMessage.slice(0, 3890)}\n…`
          }
        }

        const sent = await sendToPeer(config, peerId, finalMessage, attachmentStrings)
        if (sent) {
          console.log(`[forms-handler] VK notification sent to peer ${peerId} for submission ${submissionId} (attachments: ${attachmentStrings.length})`)
          anySent = true
        }
      }
      catch (error) {
        console.error(`[forms-handler] Failed to send VK notification to peer ${peerId}:`, error)
      }
    }

    return { sent: anySent }
  }
  catch (error) {
    console.error('[forms-handler] Failed to send VK notification:', error)
    return { sent: false }
  }
}
