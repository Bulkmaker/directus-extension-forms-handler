import type { Request } from 'express'
import type { AntispamModule, AntispamResult, AntispamConfig, FormDataWithAntispam } from './types.js'

/**
 * Time check module - rejects forms submitted too quickly
 *
 * Humans typically take at least a few seconds to fill out a form.
 * Bots submit instantly.
 */
export const timeCheckModule: AntispamModule = {
  name: 'time-check',

  async validate(
    _req: Request,
    data: FormDataWithAntispam,
    config: AntispamConfig
  ): Promise<AntispamResult> {
    const loadTime = data._loadTime as number | undefined

    // If no load time provided, skip this check
    if (!loadTime || typeof loadTime !== 'number') {
      return { passed: true }
    }

    const now = Date.now()
    const fillTimeMs = now - loadTime
    const minTimeMs = config.timeCheck.minSeconds * 1000
    const maxTimeMs = 24 * 60 * 60 * 1000 // 24 hours

    // Сначала проверяем «нереальные» времена — fillTimeMs<0 (форма из
    // будущего, расхождение часов) или > 24ч (давний tab). Иначе нижний
    // branch (< minTimeMs) перехватывал бы и отрицательные с менее
    // информативным сообщением.
    if (fillTimeMs < 0 || fillTimeMs > maxTimeMs) {
      return {
        passed: false,
        reason: 'Invalid form load time',
        log: true,
      }
    }

    if (fillTimeMs < minTimeMs) {
      return {
        passed: false,
        reason: `Form submitted too fast (${Math.round(fillTimeMs / 1000)}s < ${config.timeCheck.minSeconds}s minimum)`,
        log: true,
      }
    }

    return { passed: true }
  },
}
