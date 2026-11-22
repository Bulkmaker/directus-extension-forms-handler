import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Request } from 'express'
import { smartcaptchaModule } from '../smartcaptcha.js'
import { loadAntispamConfig, resetSmartcaptchaWarning } from '../index.js'
import type { AntispamConfig } from '../types.js'

const config: AntispamConfig = {
  honeypot: { enabled: false, fieldName: '_honeypot' },
  turnstile: { enabled: false, siteKey: '', secretKey: '' },
  hcaptcha: { enabled: false, siteKey: '', secretKey: '' },
  smartcaptcha: { enabled: true, serverKey: 'test-server-key' },
  rateLimit: { enabled: false, maxRequests: 5, windowMs: 60000 },
  timeCheck: { enabled: false, minSeconds: 3 },
}

const fakeReq = {
  headers: { 'x-real-ip': '203.0.113.7' },
  socket: { remoteAddress: '127.0.0.1' },
} as unknown as Request

function mockResponse(status: number, body: unknown = {}) {
  return { status, json: async () => body } as unknown as Response
}

describe('smartcaptchaModule', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('пропускает при status=ok', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, { status: 'ok', host: 'example.ru' }))
    const r = await smartcaptchaModule.validate(fakeReq, { _smartcaptcha: 'tok' }, config)
    expect(r.passed).toBe(true)
  })

  it('отклоняет при status=failed', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, { status: 'failed', message: 'bad' }))
    const r = await smartcaptchaModule.validate(fakeReq, { _smartcaptcha: 'tok' }, config)
    expect(r.passed).toBe(false)
    expect(r.log).toBe(true)
  })

  it('отклоняет без токена и в сеть не ходит', async () => {
    const r = await smartcaptchaModule.validate(fakeReq, {}, config)
    expect(r.passed).toBe(false)
    expect(r.log).toBe(true)
    expect(r.reason).toMatch(/token/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('пропускает при ответе 500 (fail-open) с предупреждением', async () => {
    fetchMock.mockResolvedValue(mockResponse(500))
    const r = await smartcaptchaModule.validate(fakeReq, { _smartcaptcha: 'tok' }, config)
    expect(r.passed).toBe(true)
    expect(console.warn).toHaveBeenCalled()
  })

  it('пропускает при сетевой ошибке (fail-open) с предупреждением', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const r = await smartcaptchaModule.validate(fakeReq, { _smartcaptcha: 'tok' }, config)
    expect(r.passed).toBe(true)
    expect(console.warn).toHaveBeenCalled()
  })

  it('передаёт secret, token и ip в теле form-urlencoded', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, { status: 'ok' }))
    await smartcaptchaModule.validate(fakeReq, { _smartcaptcha: 'tok-123' }, config)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://smartcaptcha.cloud.yandex.ru/validate')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
    const params = new URLSearchParams(init.body as string)
    expect(params.get('secret')).toBe('test-server-key')
    expect(params.get('token')).toBe('tok-123')
    expect(params.get('ip')).toBe('203.0.113.7')
  })

  it('включено без ключа: не блокирует и не ходит в сеть', async () => {
    const noKey = { ...config, smartcaptcha: { enabled: true, serverKey: '' } }
    const r = await smartcaptchaModule.validate(fakeReq, {}, noKey)
    expect(r.passed).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('loadAntispamConfig: smartcaptcha', () => {
  beforeEach(() => {
    resetSmartcaptchaWarning()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('по умолчанию выключено', () => {
    vi.stubEnv('ANTISPAM_SMARTCAPTCHA_ENABLED', '')
    vi.stubEnv('SMARTCAPTCHA_SERVER_KEY', '')
    const c = loadAntispamConfig()
    expect(c.smartcaptcha.enabled).toBe(false)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('включается через ANTISPAM_SMARTCAPTCHA_ENABLED=true, ключ из SMARTCAPTCHA_SERVER_KEY', () => {
    vi.stubEnv('ANTISPAM_SMARTCAPTCHA_ENABLED', 'true')
    vi.stubEnv('SMARTCAPTCHA_SERVER_KEY', 'k')
    const c = loadAntispamConfig()
    expect(c.smartcaptcha).toEqual({ enabled: true, serverKey: 'k' })
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('включено без ключа: предупреждение один раз', () => {
    vi.stubEnv('ANTISPAM_SMARTCAPTCHA_ENABLED', 'true')
    vi.stubEnv('SMARTCAPTCHA_SERVER_KEY', '')
    loadAntispamConfig()
    loadAntispamConfig()
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})
