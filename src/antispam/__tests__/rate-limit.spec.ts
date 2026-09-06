import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Request } from 'express'
import {
  rateLimitModule,
  rateLimitStore,
  sweepRateLimitStore,
  stopRateLimitSweep,
  MAX_STORE_ENTRIES,
} from '../rate-limit.js'
import { getClientIp } from '../../shared.js'
import type { AntispamConfig } from '../types.js'

const config: AntispamConfig = {
  honeypot: { enabled: false, fieldName: '_honeypot' },
  turnstile: { enabled: false, siteKey: '', secretKey: '' },
  hcaptcha: { enabled: false, siteKey: '', secretKey: '' },
  rateLimit: { enabled: true, maxRequests: 3, windowMs: 60000 },
  timeCheck: { enabled: false, minSeconds: 3 },
}

function makeReq(opts: { ip?: string; xForwardedFor?: string | string[] } = {}): Request {
  const headers: Record<string, string | string[] | undefined> = {}
  if (opts.xForwardedFor !== undefined) headers['x-forwarded-for'] = opts.xForwardedFor
  return {
    headers,
    socket: { remoteAddress: opts.ip || '127.0.0.1' },
  } as unknown as Request
}

describe('getClientIp', () => {
  it('берёт последний ip из x-forwarded-for (string)', () => {
    expect(getClientIp(makeReq({ xForwardedFor: '1.2.3.4, 5.6.7.8' }))).toBe('5.6.7.8')
  })

  it('берёт последний ip из x-forwarded-for (array)', () => {
    expect(getClientIp(makeReq({ xForwardedFor: ['9.9.9.9', '8.8.8.8'] }))).toBe('8.8.8.8')
  })

  it('игнорирует подменённый левый x-forwarded-for адрес', () => {
    expect(getClientIp(makeReq({ xForwardedFor: '203.0.113.10, 198.51.100.20, 192.0.2.30' }))).toBe('192.0.2.30')
  })

  it('падает на socket.remoteAddress если нет header', () => {
    expect(getClientIp(makeReq({ ip: '10.0.0.5' }))).toBe('10.0.0.5')
  })

  it('возвращает "unknown" если ничего нет', () => {
    const req = { headers: {}, socket: {} } as unknown as Request
    expect(getClientIp(req)).toBe('unknown')
  })
})

describe('rateLimitModule', () => {
  beforeEach(() => {
    rateLimitStore.clear()
  })

  it('пропускает первый запрос с IP', async () => {
    const r = await rateLimitModule.validate(makeReq({ ip: '1.1.1.1' }), {}, config)
    expect(r.passed).toBe(true)
  })

  it('пропускает в пределах лимита', async () => {
    const req = makeReq({ ip: '2.2.2.2' })
    for (let i = 0; i < 3; i++) {
      const r = await rateLimitModule.validate(req, {}, config)
      expect(r.passed).toBe(true)
    }
  })

  it('блочит на превышении (4-й запрос при лимите 3)', async () => {
    const req = makeReq({ ip: '3.3.3.3' })
    for (let i = 0; i < 3; i++) await rateLimitModule.validate(req, {}, config)

    const r = await rateLimitModule.validate(req, {}, config)
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/Rate limit exceeded/)
    expect(r.log).toBe(true)
  })

  it('изолирует разные IP', async () => {
    const reqA = makeReq({ ip: '4.4.4.4' })
    const reqB = makeReq({ ip: '5.5.5.5' })

    for (let i = 0; i < 3; i++) await rateLimitModule.validate(reqA, {}, config)

    // A заблокирован, B всё ещё чистый
    expect((await rateLimitModule.validate(reqA, {}, config)).passed).toBe(false)
    expect((await rateLimitModule.validate(reqB, {}, config)).passed).toBe(true)
  })

  it('сбрасывает лимит после истечения окна', async () => {
    const req = makeReq({ ip: '6.6.6.6' })
    // Заполняем лимит
    for (let i = 0; i < 3; i++) await rateLimitModule.validate(req, {}, config)
    expect((await rateLimitModule.validate(req, {}, config)).passed).toBe(false)

    // Эмулируем истечение: ставим resetAt в прошлое
    const entry = rateLimitStore.get('6.6.6.6')!
    entry.resetAt = Date.now() - 1000

    // Должен пройти и обнулить счётчик
    const r = await rateLimitModule.validate(req, {}, config)
    expect(r.passed).toBe(true)
    expect(rateLimitStore.get('6.6.6.6')?.count).toBe(1)
  })

  it('использует x-forwarded-for IP когда доступно (за прокси)', async () => {
    const reqProxied = makeReq({ ip: '127.0.0.1', xForwardedFor: '7.7.7.7' })
    await rateLimitModule.validate(reqProxied, {}, config)

    expect(rateLimitStore.has('7.7.7.7')).toBe(true)
    expect(rateLimitStore.has('127.0.0.1')).toBe(false)
  })
})

describe('sweep in-memory стора (защита от роста Map → OOM)', () => {
  beforeEach(() => {
    rateLimitStore.clear()
  })

  afterEach(() => {
    stopRateLimitSweep()
    rateLimitStore.clear()
  })

  it('удаляет записи с истёкшим окном и не трогает живые', async () => {
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      await rateLimitModule.validate(makeReq({ ip }), {}, config)
    }
    expect(rateLimitStore.size).toBe(3)

    rateLimitStore.get('10.0.0.1')!.resetAt = Date.now() - 1000
    rateLimitStore.get('10.0.0.2')!.resetAt = Date.now() - 1

    expect(sweepRateLimitStore()).toBe(2)
    expect(rateLimitStore.size).toBe(1)
    expect(rateLimitStore.has('10.0.0.3')).toBe(true)
  })

  it('ротация IP не растит стор бесконечно: после sweep остаётся 0 записей', async () => {
    for (let i = 0; i < 500; i++) {
      await rateLimitModule.validate(makeReq({ ip: `172.16.${Math.floor(i / 256)}.${i % 256}` }), {}, config)
    }
    expect(rateLimitStore.size).toBe(500)

    // все окна истекли
    const future = Date.now() + config.rateLimit.windowMs + 1
    expect(sweepRateLimitStore(future)).toBe(500)
    expect(rateLimitStore.size).toBe(0)
  })

  it('держит жёсткий потолок размера даже без sweep-тика', async () => {
    const now = Date.now()
    // Заполняем стор мимо validate — окна ещё живые, sweep их не удалит.
    for (let i = 0; i < MAX_STORE_ENTRIES + 10; i++) {
      rateLimitStore.set(`fill-${i}`, { count: 1, resetAt: now + 60_000 + i })
    }

    await rateLimitModule.validate(makeReq({ ip: '192.168.0.1' }), {}, config)

    expect(rateLimitStore.size).toBeLessThanOrEqual(MAX_STORE_ENTRIES + 1)
    expect(rateLimitStore.has('192.168.0.1')).toBe(true)
  })

  it('sweep-таймер создаётся один раз и unref-ится (не держит процесс живым)', async () => {
    stopRateLimitSweep()

    const unref = vi.fn()
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref } as never)

    try {
      await rateLimitModule.validate(makeReq({ ip: '203.0.113.1' }), {}, config)
      await rateLimitModule.validate(makeReq({ ip: '203.0.113.2' }), {}, config)

      expect(spy).toHaveBeenCalledTimes(1)
      expect(unref).toHaveBeenCalledTimes(1)
    }
    finally {
      spy.mockRestore()
      stopRateLimitSweep()
    }
  })

  it('тик таймера чистит истёкшие записи', async () => {
    stopRateLimitSweep()

    let tick: (() => void) | null = null
    const spy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation((fn: any) => {
        tick = fn
        return { unref: () => {} } as never
      })

    try {
      await rateLimitModule.validate(makeReq({ ip: '198.51.100.7' }), {}, config)
      rateLimitStore.get('198.51.100.7')!.resetAt = Date.now() - 1

      expect(tick).toBeTypeOf('function')
      tick!()

      expect(rateLimitStore.size).toBe(0)
    }
    finally {
      spy.mockRestore()
      stopRateLimitSweep()
    }
  })
})
