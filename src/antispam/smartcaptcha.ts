import type { Request } from 'express'
import type { AntispamModule, AntispamResult, AntispamConfig, FormDataWithAntispam } from './types.js'
import { getClientIp } from '../shared.js'

/**
 * Yandex SmartCaptcha, серверная проверка токена:
 * POST https://smartcaptcha.cloud.yandex.ru/validate (secret, token, ip).
 * https://yandex.cloud/ru/docs/smartcaptcha/concepts/validation
 *
 * Правило документации: ответ сервиса не 200 (сбой на стороне Яндекса),
 * сетевая ошибка и таймаут = капча считается пройденной, чтобы лид не терялся.
 */

const VALIDATE_URL = 'https://smartcaptcha.cloud.yandex.ru/validate'
const TIMEOUT_MS = 3000

export const smartcaptchaModule: AntispamModule = {
  name: 'smartcaptcha',

  async validate(
    req: Request,
    data: FormDataWithAntispam,
    config: AntispamConfig
  ): Promise<AntispamResult> {
    // Включено без ключа: проверить нечем, заявки не блокируем
    // (предупреждение пишет loadAntispamConfig)
    if (!config.smartcaptcha.serverKey) {
      return { passed: true }
    }

    const token = typeof data._smartcaptcha === 'string' ? data._smartcaptcha.trim() : ''

    if (!token) {
      return {
        passed: false,
        reason: 'Missing SmartCaptcha token',
        log: true,
      }
    }

    const ip = getClientIp(req)

    try {
      const body = new URLSearchParams({ secret: config.smartcaptcha.serverKey, token })
      if (ip) body.set('ip', ip)

      const response = await fetch(VALIDATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })

      if (response.status !== 200) {
        console.warn(`[forms-handler] SmartCaptcha unavailable (HTTP ${response.status}), skipping check`)
        return { passed: true }
      }

      const result = await response.json() as { status?: string }

      if (result?.status === 'ok') {
        return { passed: true }
      }

      return {
        passed: false,
        reason: 'SmartCaptcha verification failed',
        log: true,
      }
    } catch (error) {
      console.warn('[forms-handler] SmartCaptcha unavailable (network/timeout), skipping check:', error instanceof Error ? error.message : error)
      return { passed: true }
    }
  },
}
