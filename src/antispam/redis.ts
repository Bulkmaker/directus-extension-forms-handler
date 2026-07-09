import Redis from 'ioredis'

let redis: Redis | null = null

export function getRedisClient(): Redis | null {
  if (redis) return redis

  const url = process.env.REDIS || process.env.REDIS_URL
  if (!url) {
    console.warn('[forms-handler] REDIS environment variable not set, rate-limiter will stay in memory')
    return null
  }

  try {
    redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => {
        if (times > 3) {
          console.error('[forms-handler] Redis connection failed after 3 retries, falling back to memory')
          return null
        }
        return Math.min(times * 200, 1000)
      }
    })

    redis.on('error', (err) => {
      console.error('[forms-handler] Redis error:', err)
    })

    return redis
  } catch (err) {
    console.error('[forms-handler] Failed to initialize Redis client:', err)
    return null
  }
}
