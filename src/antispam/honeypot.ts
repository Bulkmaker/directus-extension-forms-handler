import type { Request } from 'express'
import type { AntispamModule, AntispamResult, AntispamConfig, FormDataWithAntispam } from './types.js'

/**
 * Honeypot module - hidden field that bots fill but humans don't
 *
 * If the honeypot field has any value, the submission is from a bot.
 * We return "silent" so the bot thinks it succeeded.
 */
export const honeypotModule: AntispamModule = {
  name: 'honeypot',

  async validate(
    _req: Request,
    data: FormDataWithAntispam,
    config: AntispamConfig
  ): Promise<AntispamResult> {
    const fieldName = config.honeypot.fieldName || '_honeypot'
    const honeypotValue = data[fieldName] as string | undefined

    // If honeypot field has any value, it's a bot
    if (honeypotValue && honeypotValue.trim().length > 0) {
      return {
        passed: false,
        reason: 'Honeypot field filled',
        silent: true, // Don't reveal detection - fake success
        log: true,
      }
    }

    return { passed: true }
  },
}
