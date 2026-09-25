import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rateLimitStore, stopRateLimitSweep } from '../antispam/rate-limit.js'

vi.mock('../telegram.js', () => ({
  sendTelegramNotification: vi.fn(async () => ({ sent: false })),
}))
vi.mock('../vk.js', () => ({
  sendVkNotification: vi.fn(async () => ({ sent: false })),
}))
vi.mock('../max.js', () => ({
  sendMaxNotification: vi.fn(async () => ({ sent: false })),
}))
vi.mock('../email.js', () => ({
  sendEmailNotification: vi.fn(async () => false),
}))

const endpoint = (await import('../index.js')).default

type Handler = (req: any, res: any) => Promise<void>

function getSubmitHandler(): Handler {
  let handler: Handler | null = null

  const router = {
    post: (path: string, fn: Handler) => {
      if (path === '/submit') handler = fn
    },
    get: () => {},
  }

  const createOne = vi.fn(async () => 'sub-1')
  const context = {
    services: {
      ItemsService: class {
        createOne = createOne
        updateOne = vi.fn(async () => 'sub-1')
      },
    },
    getSchema: async () => ({}),
  }

  endpoint.handler(router as any, context as any)
  if (!handler) throw new Error('POST /submit не зарегистрирован')
  return handler
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: null as any,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(payload: any) {
      res.body = payload
      return res
    },
  }
  return res
}

function makeReq(body: Record<string, unknown>, ip: string) {
  return { headers: { 'x-real-ip': ip, 'user-agent': 'vitest' }, body, socket: {} }
}

const validBody = {
  form_key: 'contact',
  name: 'Иван',
  phone: '+79991112233',
  agree: true,
}

describe('POST /forms/submit — ответ клиенту', () => {
  beforeEach(() => {
    rateLimitStore.clear()
  })

  afterEach(() => {
    stopRateLimitSweep()
    rateLimitStore.clear()
  })

  it('НЕ отдаёт причину антиспама (параметры лимитов — подсказка спамеру)', async () => {
    const handler = getSubmitHandler()
    const res = makeRes()

    // _loadTime «только что» → time-check: submitted too fast
    await handler(makeReq({ ...validBody, _loadTime: Date.now() }, '203.0.113.50'), res)

    expect(res.statusCode).toBe(400)
    expect(res.body.success).toBe(false)
    expect(res.body.error).toBe('Проверка безопасности не пройдена')
    expect(res.body).not.toHaveProperty('details')
    expect(JSON.stringify(res.body)).not.toMatch(/minimum|Rate limit|requests per/i)
  })

  it('причина антиспама пишется в серверный лог', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handler = getSubmitHandler()

    try {
      await handler(makeReq({ ...validBody, _loadTime: Date.now() }, '203.0.113.51'), makeRes())

      const logged = warn.mock.calls.map(call => JSON.stringify(call)).join('\n')
      expect(logged).toMatch(/Antispam failed/)
      expect(logged).toMatch(/too fast/)
    }
    finally {
      warn.mockRestore()
    }
  })

  it('ошибки валидации полей формы по-прежнему доходят до клиента', async () => {
    const handler = getSubmitHandler()
    const res = makeRes()

    // без _loadTime time-check пропускает → падаем именно на валидации
    await handler(makeReq({ ...validBody, phone: 'abc' }, '203.0.113.52'), res)

    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('Ошибка валидации')
    expect(res.body.details).toEqual(
      expect.arrayContaining(['phone: Неверный формат телефона']),
    )
  })

  it('ошибка «имя слишком короткое» тоже доходит до клиента', async () => {
    const handler = getSubmitHandler()
    const res = makeRes()

    await handler(makeReq({ ...validBody, name: 'И' }, '203.0.113.55'), res)

    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('Ошибка валидации')
    expect(res.body.details).toContain('name: Имя слишком короткое')
  })

  it('валидная заявка сохраняется и отдаёт 201', async () => {
    const handler = getSubmitHandler()
    const res = makeRes()

    await handler(makeReq({ ...validBody }, '203.0.113.53'), res)

    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual({ success: true, id: 'sub-1' })
  })

  it('honeypot по-прежнему получает фейковый успех (silent reject)', async () => {
    const handler = getSubmitHandler()
    const res = makeRes()

    await handler(makeReq({ ...validBody, _honeypot: 'bot' }, '203.0.113.54'), res)

    expect(res.statusCode).toBe(201)
    expect(res.body.success).toBe(true)
  })
})

describe('POST /forms/submit — флаги уведомлений', () => {
  beforeEach(() => {
    rateLimitStore.clear()
  })

  afterEach(() => {
    stopRateLimitSweep()
    rateLimitStore.clear()
    vi.restoreAllMocks()
  })

  function setup(schema: unknown, updateImpl?: () => Promise<unknown>) {
    let handler: Handler | null = null
    const updateOne = vi.fn(updateImpl ?? (async () => 'sub-1'))
    const router = {
      post: (path: string, fn: Handler) => { if (path === '/submit') handler = fn },
      get: () => {},
    }
    const context = {
      services: {
        ItemsService: class {
          createOne = vi.fn(async () => 'sub-1')
          updateOne = updateOne
        },
      },
      getSchema: async () => schema,
    }
    endpoint.handler(router as any, context as any)
    return { handler: handler!, updateOne }
  }

  async function allSent() {
    const { sendTelegramNotification } = await import('../telegram.js')
    const { sendVkNotification } = await import('../vk.js')
    const { sendMaxNotification } = await import('../max.js')
    vi.mocked(sendTelegramNotification).mockResolvedValueOnce({ sent: true })
    vi.mocked(sendVkNotification).mockResolvedValueOnce({ sent: true })
    vi.mocked(sendMaxNotification).mockResolvedValueOnce({ sent: true })
  }

  it('пишет max_notified, если поле есть в схеме', async () => {
    await allSent()
    const schema = { collections: { lead_submissions: { fields: {
      telegram_notified: {}, vk_notified: {}, max_notified: {}, email_notified: {},
    } } } }
    const { handler, updateOne } = setup(schema)
    const res = makeRes()

    await handler(makeReq({ ...validBody }, '203.0.113.60'), res)

    expect(res.statusCode).toBe(201)
    expect(updateOne).toHaveBeenCalledWith('sub-1', {
      telegram_notified: true, vk_notified: true, max_notified: true,
    })
  })

  it('нет полей vk_notified/max_notified — пишет только telegram_notified, заявка 201', async () => {
    await allSent()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const schema = { collections: { lead_submissions: { fields: { telegram_notified: {} } } } }
    const { handler, updateOne } = setup(schema)
    const res = makeRes()

    await handler(makeReq({ ...validBody }, '203.0.113.61'), res)

    expect(res.statusCode).toBe(201)
    expect(updateOne).toHaveBeenCalledWith('sub-1', { telegram_notified: true })
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/vk_notified, max_notified/)
  })

  it('схема неизвестна и updateOne падает — всё равно 201', async () => {
    await allSent()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { handler } = setup({}, async () => { throw new Error('field "max_notified" does not exist') })
    const res = makeRes()

    await handler(makeReq({ ...validBody }, '203.0.113.62'), res)

    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual({ success: true, id: 'sub-1' })
  })
})
