import { defineEndpoint } from '@directus/extensions-sdk'
import { runAntispamChecks, loadAntispamConfig } from './antispam/index.js'
import { validateForm } from './validation.js'
import type { FormData } from './validation.js'
import { sendTelegramNotification } from './telegram.js'
import { sendVkNotification } from './vk.js'
import { sendMaxNotification, fetchMaxSenders } from './max.js'
import { sendEmailNotification, sendTenantEmail } from './email.js'
import { getClientIp, filterFlagsBySchema } from './shared.js'
import {
  DELIVERY_STATUS_FIELD,
  ensureRoutesSchemaOnce,
  findActiveRoute,
  routesEnabled,
} from './routes.js'
import { deliverByRoute, formatDeliveryStatus, type DeliveryReport, type OwnerChannels } from './routing.js'

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

  // Маршруты заявок (form_routes): схема создаётся при старте, только если включено.
  if (routesEnabled()) {
    const timer = setTimeout(() => {
      void ensureRoutesSchemaOnce({ services, getSchema }, process.env.FORMS_COLLECTION || 'lead_submissions')
    }, 3000)
    timer.unref?.()
  }

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

      // Regular reject.
      // Причины антиспама наружу НЕ отдаём: в них параметры защиты
      // («5 requests per 60s», «1s < 3s minimum») — по ним спамер калибрует обход.
      // Детали остаются в серверном логе. Ошибки ВАЛИДАЦИИ полей (ниже) клиенту
      // по-прежнему возвращаются: их показывает пользователю форма.
      if (!antispamResult.passed) {
        console.warn(`[forms-handler] Antispam failed for IP: ${ip}`, antispamResult.errors)
        return res.status(400).json({
          success: false,
          error: 'Проверка безопасности не пройдена',
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
      const collection = process.env.FORMS_COLLECTION || 'lead_submissions'
      const itemsService = new ItemsService(collection, {
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

      // 4–5. Уведомления. Есть активный маршрут form_routes для form_key — заявка
      //      уходит арендатору и (copy_to_owner) копией в глобальные каналы.
      //      Нет маршрута (или FORMS_ROUTES_ENABLED не включён) — как раньше.
      const directusContext = { services, getSchema }
      const notifyOwner = async (routeNote?: string): Promise<OwnerChannels> => {
        const telegramResult = await sendTelegramNotification(formData, submissionId, sourceUrl, directusContext)
        const vkResult = await sendVkNotification(formData, submissionId, sourceUrl, directusContext)
        const maxResult = await sendMaxNotification(formData, submissionId, sourceUrl, directusContext)
        const emailSent = await sendEmailNotification(formData, submissionId, sourceUrl, directusContext, routeNote ? { routeNote } : undefined)
        return { telegram: telegramResult.sent, vk: vkResult.sent, max: maxResult.sent, email: emailSent }
      }

      const route = routesEnabled() ? await findActiveRoute(formData.form_key, directusContext) : null
      let owner: OwnerChannels = {}
      let report: DeliveryReport | null = null
      if (route) {
        report = await deliverByRoute(
          route,
          {
            email: to => sendTenantEmail(formData, submissionId, to, sourceUrl, directusContext),
            telegram: async (chatIds) => {
              const result = await sendTelegramNotification(formData, submissionId, sourceUrl, directusContext, { chatIds })
              return result.sent ? { ok: true } : { ok: false, error: 'не доставлено (подробности в логе Directus)' }
            },
            max: async (targets) => {
              const result = await sendMaxNotification(formData, submissionId, sourceUrl, directusContext, { recipients: targets })
              return { ok: result.sent, ...(result.errors.length > 0 ? { error: result.errors.join('; ') } : {}) }
            },
          },
          async (note) => {
            owner = await notifyOwner(note)
            return owner
          },
        )
      }
      else {
        owner = await notifyOwner()
      }

      // 6. Persist notification flags — НЕ должно ронять ответ:
      //    лид уже сохранён (createOne выше), флаги вторичны. Сбой updateOne
      //    раньше уходил в общий catch → 500 → юзер повторял отправку → дубль лида.
      //    Один updateOne вместо нескольких (меньше запросов).
      const notifyFlags: Record<string, boolean> = {}
      if (owner.telegram || report?.tenant.telegram?.ok) notifyFlags.telegram_notified = true
      if (owner.vk) notifyFlags.vk_notified = true // требует поля vk_notified в схеме (см. M3)
      if (owner.max || report?.tenant.max?.ok) notifyFlags.max_notified = true // требует поля max_notified в схеме
      if (owner.email || report?.tenant.email?.ok) notifyFlags.email_notified = true

      const { flags: flagsToWrite, skipped } = filterFlagsBySchema(notifyFlags, schema, collection)
      if (skipped.length > 0) {
        console.warn(`[forms-handler] В коллекции ${collection} нет полей ${skipped.join(', ')} — эти флаги не записаны (уведомления ушли)`)
      }

      // Журнал доставки по маршруту: JSON в fields._delivery + читаемый delivery_status.
      const updateData: Record<string, unknown> = { ...flagsToWrite }
      if (report) {
        const collectionFields = schema?.collections?.[collection]?.fields
        if (!collectionFields || 'fields' in collectionFields) {
          updateData.fields = { ...(isPlainObject(dbData.fields) ? dbData.fields : {}), _delivery: report }
        }
        if (collectionFields && DELIVERY_STATUS_FIELD in collectionFields) {
          updateData[DELIVERY_STATUS_FIELD] = formatDeliveryStatus(report)
        }
      }

      if (Object.keys(updateData).length > 0) {
        try {
          await itemsService.updateOne(submissionId, updateData)
        } catch (flagErr) {
          // Если схема неизвестна и поля vk_notified/max_notified нет — updateOne
          // упадёт здесь, но заявка валидна и ответ должен быть 201. Log-and-continue.
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
   * GET /forms/routes/max-updates — только администратору Directus.
   * Кто написал MAX-боту заявок: user_id и код из ссылки ?start=… — для form_routes.
   */
  router.get('/routes/max-updates', async (req: any, res: any) => {
    if (req.accountability?.admin !== true) {
      return res.status(403).json({ success: false, error: 'Только для администратора' })
    }
    const result = await fetchMaxSenders()
    if (!result.ok) return res.status(502).json({ success: false, error: result.error })
    return res.json({ success: true, senders: result.senders })
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
