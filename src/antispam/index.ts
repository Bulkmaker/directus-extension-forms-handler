import type { Request } from 'express'
import type { AntispamConfig, AntispamCheckResult, FormDataWithAntispam } from './types.js'
import { honeypotModule } from './honeypot.js'
import { turnstileModule } from './turnstile.js'
import { hcaptchaModule } from './hcaptcha.js'
import { rateLimitModule } from './rate-limit.js'
import { timeCheckModule } from './time-check.js'

export * from './types.js'

/**
 * Run all enabled antispam checks
 *
 * Modules are executed in order:
 * 1. Rate limit (fail fast for flooding)
 * 2. Honeypot (silent reject for bots)
 * 3. Time check (fast submissions)
 * 4. CAPTCHA (Turnstile or hCaptcha)
 */
export async function runAntispamChecks(
  req: Request,
  data: FormDataWithAntispam,
  config: AntispamConfig
): Promise<AntispamCheckResult> {
  const errors: string[] = []

  // Build list of enabled modules in execution order
  const modules = [
    config.rateLimit.enabled && rateLimitModule,
    config.honeypot.enabled && honeypotModule,
    config.timeCheck.enabled && timeCheckModule,
    config.turnstile.enabled && turnstileModule,
    config.hcaptcha.enabled && hcaptchaModule,
  ].filter((m): m is NonNullable<typeof m> => Boolean(m))

  for (const module of modules) {
    try {
      const result = await module.validate(req, data, config)

      if (!result.passed) {
        console.log(`[forms-handler] Antispam check failed: ${module.name} - ${result.reason}`)

        // Silent reject (honeypot) - return fake success
        if (result.silent) {
          return {
            passed: false,
            errors: [],
            silentReject: true,
          }
        }

        errors.push(result.reason || `${module.name} check failed`)
      }
    } catch (error) {
      console.error(`[forms-handler] Antispam module ${module.name} error:`, error)
      errors.push(`${module.name} check error`)
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    silentReject: false,
  }
}

/**
 * Load antispam config from environment variables
 */
export function loadAntispamConfig(): AntispamConfig {
  return {
    honeypot: {
      enabled: process.env.ANTISPAM_HONEYPOT_ENABLED !== 'false',
      fieldName: process.env.ANTISPAM_HONEYPOT_FIELD || '_honeypot',
    },
    turnstile: {
      enabled: process.env.ANTISPAM_TURNSTILE_ENABLED === 'true',
      siteKey: process.env.TURNSTILE_SITE_KEY || '',
      secretKey: process.env.TURNSTILE_SECRET_KEY || '',
    },
    hcaptcha: {
      enabled: process.env.ANTISPAM_HCAPTCHA_ENABLED === 'true',
      siteKey: process.env.HCAPTCHA_SITE_KEY || '',
      secretKey: process.env.HCAPTCHA_SECRET_KEY || '',
    },
    rateLimit: {
      enabled: process.env.ANTISPAM_RATE_LIMIT_ENABLED !== 'false',
      maxRequests: parseInt(process.env.ANTISPAM_RATE_LIMIT_MAX || '5', 10),
      windowMs: parseInt(process.env.ANTISPAM_RATE_LIMIT_WINDOW || '60000', 10),
    },
    timeCheck: {
      enabled: process.env.ANTISPAM_TIME_CHECK_ENABLED !== 'false',
      minSeconds: parseInt(process.env.ANTISPAM_TIME_CHECK_MIN_SECONDS || '3', 10),
    },
  }
}
