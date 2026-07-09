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
    const now = Date.now()
    const entry = rateLimitStore.get(ip)

    if (!entry || entry.resetAt < now) {
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
export { rateLimitStore }
