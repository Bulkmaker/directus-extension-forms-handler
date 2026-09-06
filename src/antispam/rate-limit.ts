import type { Request } from 'express'
import { getClientIp } from '../shared.js'
import { getRedisClient } from './redis.js'
import type { AntispamModule, AntispamResult, AntispamConfig, FormDataWithAntispam } from './types.js'

/**
 * Rate limit entry for in-memory fallback
 */
interface RateLimitEntry {
  count: number
  resetAt: number
}

const rateLimitStore = new Map<string, RateLimitEntry>()

/** Как часто подчищаем записи с истёкшим окном. */
const SWEEP_INTERVAL_MS = 60_000

/** Жёсткий потолок числа ключей — страховка, если sweep не успевает за рассылкой. */
const MAX_STORE_ENTRIES = 20_000

let sweepTimer: ReturnType<typeof setInterval> | null = null

/**
 * Удаляет записи с истёкшим окном. Без этого Map растёт бесконечно: запись по IP
 * создаётся при первом запросе и перезаписывается при следующем, но НИКОГДА не
 * удаляется. Рассылка заявок с ротацией IP наращивала стор без потолка → OOM
 * Directus (Redis в этом стеке не используется, CACHE_STORE=memory).
 * Возвращает число удалённых ключей.
 */
export function sweepRateLimitStore(now: number = Date.now()): number {
  let removed = 0
  for (const [key, entry] of rateLimitStore) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key)
      removed++
    }
  }
  return removed
}

/** Если даже после sweep стор переполнен — выкидываем записи с самым ранним resetAt. */
function enforceStoreCap(): void {
  if (rateLimitStore.size <= MAX_STORE_ENTRIES) return

  const overflow = rateLimitStore.size - MAX_STORE_ENTRIES
  const victims = [...rateLimitStore.entries()]
    .sort((a, b) => a[1].resetAt - b[1].resetAt)
    .slice(0, overflow)

  for (const [key] of victims) rateLimitStore.delete(key)
}

/**
 * Ленивый запуск sweep-таймера: только когда реально используется in-memory
 * фоллбэк. Повторный вызов таймер не дублирует (модуль может быть
 * проинициализирован дважды), а unref() не даёт таймеру держать процесс живым.
 */
function ensureSweepTimer(): void {
  if (sweepTimer) return

  sweepTimer = setInterval(() => {
    sweepRateLimitStore()
  }, SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
}

/** Остановка sweep-таймера (тесты / graceful shutdown). */
export function stopRateLimitSweep(): void {
  if (!sweepTimer) return
  clearInterval(sweepTimer)
  sweepTimer = null
}

/**
 * Rate limiting module - limits requests per IP
 * Uses Redis if available, falls back to in-memory module Map.
 */
export const rateLimitModule: AntispamModule = {
  name: 'rate-limit',

  async validate(
    req: Request,
    _data: FormDataWithAntispam,
    config: AntispamConfig
  ): Promise<AntispamResult> {
    const ip = getClientIp(req)
    const { maxRequests, windowMs } = config.rateLimit
    const redis = getRedisClient()

    if (redis) {
      try {
        const key = `rate-limit:${ip}`
        const current = await redis.incr(key)
        
        if (current === 1) {
          await redis.expire(key, Math.ceil(windowMs / 1000))
        }

        if (current > maxRequests) {
          return {
            passed: false,
            reason: `Rate limit exceeded (${maxRequests} requests per ${windowMs / 1000}s)`,
            log: true,
          }
        }
        return { passed: true }
      } catch (err) {
        console.error('[forms-handler] Redis rate-limit failed, falling back to memory:', err)
      }
    }

    // --- In-memory fallback ---
    ensureSweepTimer()

    const now = Date.now()
    const entry = rateLimitStore.get(ip)

    if (!entry || entry.resetAt < now) {
      // Новый ключ — момент, когда стор растёт. Здесь же и подчищаем, если
      // между тиками таймера набежало слишком много записей.
      if (rateLimitStore.size >= MAX_STORE_ENTRIES) {
        sweepRateLimitStore(now)
        enforceStoreCap()
      }

      rateLimitStore.set(ip, {
        count: 1,
        resetAt: now + windowMs,
      })
      return { passed: true }
    }

    if (entry.count >= maxRequests) {
      return {
        passed: false,
        reason: `Rate limit exceeded (${maxRequests} requests per ${windowMs / 1000}s) [memory]`,
        log: true,
      }
    }

    entry.count++
    return { passed: true }
  },
}

/**
 * Export for testing
 */
export { rateLimitStore, MAX_STORE_ENTRIES }
