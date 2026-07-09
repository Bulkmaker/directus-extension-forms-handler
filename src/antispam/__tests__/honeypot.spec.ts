import { describe, it, expect } from 'vitest'
import type { Request } from 'express'
import { honeypotModule } from '../honeypot.js'
import type { AntispamConfig } from '../types.js'

const config: AntispamConfig = {
  honeypot: { enabled: true, fieldName: '_honeypot' },
  turnstile: { enabled: false, siteKey: '', secretKey: '' },
  hcaptcha: { enabled: false, siteKey: '', secretKey: '' },
  rateLimit: { enabled: false, maxRequests: 5, windowMs: 60000 },
  timeCheck: { enabled: false, minSeconds: 3 },
}

const fakeReq = {} as Request

describe('honeypotModule', () => {
  it('passes when honeypot field is empty', async () => {
    const r = await honeypotModule.validate(fakeReq, { _honeypot: '' }, config)
    expect(r.passed).toBe(true)
  })

  it('passes when honeypot field is missing entirely', async () => {
    const r = await honeypotModule.validate(fakeReq, { name: 'Иван' }, config)
    expect(r.passed).toBe(true)
  })

  it('passes when honeypot is whitespace-only (humans not affected)', async () => {
    const r = await honeypotModule.validate(fakeReq, { _honeypot: '   ' }, config)
    expect(r.passed).toBe(true)
  })

  it('fails silently when honeypot is filled (bot)', async () => {
    const r = await honeypotModule.validate(fakeReq, { _honeypot: 'spam' }, config)
    expect(r.passed).toBe(false)
    expect(r.silent).toBe(true)
    expect(r.log).toBe(true)
    expect(r.reason).toMatch(/honeypot/i)
  })

  it('respects custom fieldName from config', async () => {
    const customConfig = { ...config, honeypot: { enabled: true, fieldName: 'website_url' } }
    const r = await honeypotModule.validate(fakeReq, { website_url: 'http://spam.com' }, customConfig)
    expect(r.passed).toBe(false)
    expect(r.silent).toBe(true)
  })
})
