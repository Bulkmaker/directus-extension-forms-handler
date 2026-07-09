import type { Request } from 'express'
import type { AntispamModule, AntispamResult, AntispamConfig, FormDataWithAntispam } from './types.js'

/**
 * hCaptcha verification (alternative to Turnstile)
 *
 * Privacy-focused CAPTCHA provider.
 * https://docs.hcaptcha.com/
 */
export const hcaptchaModule: AntispamModule = {
  name: 'hcaptcha',

  async validate(
    _req: Request,
    data: FormDataWithAntispam,
    config: AntispamConfig
  ): Promise<AntispamResult> {
    const token = data._hcaptcha as string | undefined

    if (!token) {
      return {
        passed: false,
        reason: 'Missing hCaptcha token',
        log: false,
      }
    }

    try {
      const params = new URLSearchParams({
        secret: config.hcaptcha.secretKey,
        response: token,
      })

      const response = await fetch('https://hcaptcha.com/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      })

      const result = await response.json() as { success: boolean; 'error-codes'?: string[] }

      if (!result.success) {
        return {
          passed: false,
          reason: `hCaptcha verification failed: ${result['error-codes']?.join(', ') || 'unknown'}`,
          log: true,
        }
      }

      return { passed: true }
    } catch (error) {
      console.error('[forms-handler] hCaptcha verification error:', error)
      return {
        passed: false,
        reason: 'hCaptcha verification service unavailable',
        log: true,
      }
    }
  },
}
