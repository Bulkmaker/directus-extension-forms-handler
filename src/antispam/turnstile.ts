import type { Request } from 'express'
import type { AntispamModule, AntispamResult, AntispamConfig, FormDataWithAntispam } from './types.js'

/**
 * Cloudflare Turnstile CAPTCHA verification
 *
 * Works well in Russia (unlike reCAPTCHA), invisible mode available.
 * https://developers.cloudflare.com/turnstile/
 */
export const turnstileModule: AntispamModule = {
  name: 'turnstile',

  async validate(
    _req: Request,
    data: FormDataWithAntispam,
    config: AntispamConfig
  ): Promise<AntispamResult> {
    const token = data._turnstile as string | undefined

    if (!token) {
      return {
        passed: false,
        reason: 'Missing Turnstile token',
        log: false,
      }
    }

    try {
      const response = await fetch(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            secret: config.turnstile.secretKey,
            response: token,
          }),
        }
      )

      const result = await response.json() as { success: boolean; 'error-codes'?: string[] }

      if (!result.success) {
        return {
          passed: false,
          reason: `Turnstile verification failed: ${result['error-codes']?.join(', ') || 'unknown'}`,
          log: true,
        }
      }

      return { passed: true }
    } catch (error) {
      console.error('[forms-handler] Turnstile verification error:', error)
      return {
        passed: false,
        reason: 'Turnstile verification service unavailable',
        log: true,
      }
    }
  },
}
