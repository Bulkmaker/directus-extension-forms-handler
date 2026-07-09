import { defineEndpoint } from '@directus/extensions-sdk'
import { runAntispamChecks, loadAntispamConfig } from './antispam/index.js'
import { validateForm } from './validation.js'
import type { FormData } from './validation.js'
import { sendTelegramNotification } from './telegram.js'
import { sendVkNotification } from './vk.js'
import { sendEmailNotification } from './email.js'
import { getClientIp } from './shared.js'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function buildExtendedPayload(formData: FormData) {
  const fields = isPlainObject(formData.fields) ? formData.fields : {}
  const fieldMeta = isPlainObject(formData.field_meta) ? formData.field_meta : {}
  const attachments = Array.isArray(formData.attachments) ? formData.attachments : []

  const hasExtendedData =
    Object.keys(fields).length > 0
    || Object.keys(fieldMeta).length > 0
    || attachments.length > 0
    || Boolean(formData.form_key)
    || Boolean(formData.form_title)

  if (!hasExtendedData) {
    return null
  }

  return {
    form_key: formData.form_key,
    form_title: formData.form_title,
    fields,
    field_meta: fieldMeta,
    attachments,
  }
}

export default {
  id: 'forms',
  handler: (router: any, context: any) => {
  const { services, getSchema } = context

  /**
   * POST /forms/submit
   *
   * Main endpoint for form submissions
   */
  router.post('/submit', async (req, res) => {
    try {
      const ip = getClientIp(req)
      const userAgent = req.headers['user-agent'] || ''
      const bodySource = typeof req.body?.source_url === 'string' ? req.body.source_url : ''
      const sourceUrl = bodySource || req.headers.referer || req.headers.origin || ''

      console.log(`[forms-handler] New submission from IP: ${ip}`)

      // 1. Run antispam checks
      const antispamConfig = loadAntispamConfig()
      const antispamResult = await runAntispamChecks(req, req.body, antispamConfig)

      // Silent reject (honeypot) - return fake success
      if (antispamResult.silentReject) {
        console.log(`[forms-handler] Silent reject (honeypot) for IP: ${ip}`)
        return res.status(201).json({ success: true, id: 'fake-' + Date.now() })
      }

      // Regular reject
      if (!antispamResult.passed) {
        console.log(`[forms-handler] Antispam failed for IP: ${ip}`, antispamResult.errors)
        return res.status(400).json({
          success: false,
          error: 'Проверка безопасности не пройдена',
          details: antispamResult.errors,
        })
      }

      // 2. Validate form data
      const validation = validateForm(req.body)

      if (!validation.success) {
        console.log(`[forms-handler] Validation failed:`, validation.errors)
        return res.status(400).json({
          success: false,
          error: 'Ошибка валидации',
          details: validation.errors,
        })
      }

      const formData = validation.data!

      // 3. Save to Directus
      const schema = await getSchema()
      const { ItemsService } = services
      const itemsService = new ItemsService(process.env.FORMS_COLLECTION || 'lead_submissions', {
        schema,
        accountability: { admin: true }, // Use admin context for creation
      })

      // Prepare data for database — имена полей универсальной схемы платформы
      // (lead_submissions, DIRECTUS-SEEDS §1); donor-имена (type/ip_address/
      // calculator_data) заменены при переносе.
      const dbData: Record<string, unknown> = {
        status: 'new',
        form_key: formData.form_key || formData.type || 'form',
        form_title: formData.form_title || null,
        name: formData.name,
        phone: formData.phone,
        email: formData.email || null,
        message: formData.message || null,
        ip: ip,
        // varchar(255) в схеме платформы — режем до лимита колонки
        user_agent: userAgent.substring(0, 255),
        source_url: sourceUrl.substring(0, 255),
        telegram_notified: false,
        email_notified: false,
        webhook_notified: false,
      }

      const extendedPayload = buildExtendedPayload(formData)
      const calculatorData = isPlainObject(formData.calculator_data)
        ? { ...formData.calculator_data }
        : {}

      if (extendedPayload) {
        calculatorData._form = extendedPayload
      }

      if (Object.keys(calculatorData).length > 0) {
        dbData.fields = calculatorData
      }

      const submissionId = await itemsService.createOne(dbData)
      console.log(`[forms-handler] Created submission: ${submissionId}`)

      // 4. Send bot notifications (pass sourceUrl for page link + Directus context for image URLs).
      const telegramResult = await sendTelegramNotification(formData, submissionId, sourceUrl, { services, getSchema })
      const vkResult = await sendVkNotification(formData, submissionId, sourceUrl, { services, getSchema })

      // 5. Send email notification
      const emailSent = await sendEmailNotification(formData, submissionId, sourceUrl, { services, getSchema })

      // 6. Persist notification flags — НЕ должно ронять ответ:
      //    лид уже сохранён (createOne выше), флаги вторичны. Сбой updateOne
      //    раньше уходил в общий catch → 500 → юзер повторял отправку → дубль лида.
      //    Один updateOne вместо нескольких (меньше запросов).
      const notifyFlags: Record<string, boolean> = {}
      if (telegramResult.sent) notifyFlags.telegram_notified = true
      if (vkResult.sent) notifyFlags.vk_notified = true // требует поля vk_notified в схеме (см. M3)
      if (emailSent) notifyFlags.email_notified = true

      if (Object.keys(notifyFlags).length > 0) {
        try {
          await itemsService.updateOne(submissionId, notifyFlags)
        } catch (flagErr) {
          // Если поле vk_notified ещё не создано в схеме — updateOne упадёт здесь,
          // но заявка валидна и ответ должен быть 201. Log-and-continue.
          console.error(`[forms-handler] Не удалось записать notify-флаги для ${submissionId}:`, flagErr)
        }
      }

      // 7. Return success
      return res.status(201).json({
        success: true,
        id: submissionId,
      })
    } catch (error) {
      console.error('[forms-handler] Error processing submission:', error)
      return res.status(500).json({
        success: false,
        error: 'Внутренняя ошибка сервера',
      })
    }
  })

  /**
   * GET /forms/health
   *
   * Health check endpoint
   */
  router.get('/health', (_req, res) => {
    const config = loadAntispamConfig()

    res.json({
      status: 'ok',
      antispam: {
        honeypot: config.honeypot.enabled,
        turnstile: config.turnstile.enabled,
        hcaptcha: config.hcaptcha.enabled,
        rateLimit: config.rateLimit.enabled,
        timeCheck: config.timeCheck.enabled,
      },
    })
  })
  },
}
