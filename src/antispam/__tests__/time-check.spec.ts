import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Request } from 'express'
import { timeCheckModule } from '../time-check.js'
import type { AntispamConfig } from '../types.js'

const config: AntispamConfig = {
  honeypot: { enabled: false, fieldName: '_honeypot' },
  turnstile: { enabled: false, siteKey: '', secretKey: '' },
  hcaptcha: { enabled: false, siteKey: '', secretKey: '' },
  rateLimit: { enabled: false, maxRequests: 5, windowMs: 60000 },
  timeCheck: { enabled: true, minSeconds: 3 },
}

const fakeReq = {} as Request

describe('timeCheckModule', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-03T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('пропускает если loadTime не указан (legacy/no JS)', async () => {
    const r = await timeCheckModule.validate(fakeReq, { name: 'Иван' }, config)
    expect(r.passed).toBe(true)
  })

  it('пропускает если loadTime — не число', async () => {
    const r = await timeCheckModule.validate(fakeReq, { _loadTime: 'abc' as unknown as number }, config)
    expect(r.passed).toBe(true)
  })

  it('блочит мгновенный submit (<minSeconds)', async () => {
    const now = Date.now()
    const r = await timeCheckModule.validate(fakeReq, { _loadTime: now - 500 }, config)
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/too fast/)
    expect(r.log).toBe(true)
  })

  it('пропускает submit ровно через minSeconds (граница включительно — проходит)', async () => {
    const now = Date.now()
    const r = await timeCheckModule.validate(fakeReq, { _loadTime: now - 3000 }, config)
    expect(r.passed).toBe(true)
  })

  it('пропускает разумно медленный submit', async () => {
    const now = Date.now()
    const r = await timeCheckModule.validate(fakeReq, { _loadTime: now - 30_000 }, config)
    expect(r.passed).toBe(true)
  })

  it('блочит loadTime из будущего (отрицательный fillTime) как Invalid', async () => {
    const now = Date.now()
    const r = await timeCheckModule.validate(fakeReq, { _loadTime: now + 10_000 }, config)
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/Invalid form load time/)
  })

  it('блочит loadTime старше 24 часов (вкладка зависла)', async () => {
    const now = Date.now()
    const r = await timeCheckModule.validate(fakeReq, { _loadTime: now - 25 * 60 * 60 * 1000 }, config)
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/Invalid form load time/)
  })
})
