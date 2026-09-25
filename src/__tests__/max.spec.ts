import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendMaxNotification, formatMaxMessage, protectPrices } from '../max.js'
import type { FormData } from '../validation.js'

const TOKEN = 'max-secret-token-123'

const baseFormData: FormData = {
  form_key: 'callback',
  form_title: 'Обратный звонок',
  type: 'contact',
  device: 'desktop',
  attachments: [],
  fields: { name: 'Иван', phone: '+79991112233', comment_time: 'после 18:00' },
  field_meta: { comment_time: { label: 'Удобное время' } },
  name: 'Иван',
  phone: '+79991112233',
  email: null,
  message: 'Тест',
  agree: true,
} as unknown as FormData

function okResponse() {
  return { ok: true, status: 200, json: async () => ({ message: { body: { mid: 'm1' } } }) }
}

function errorResponse(status: number, body: unknown) {
  return { ok: false, status, json: async () => body }
}

function allLogs(...spies: ReturnType<typeof vi.spyOn>[]): string {
  return spies.flatMap(spy => spy.mock.calls.map(call => call.map(String).join(' '))).join('\n')
}

describe('formatMaxMessage', () => {
  it('содержит тип формы, контакты, поля, страницу и футер', () => {
    const text = formatMaxMessage(baseFormData, 'https://taurusdom.ru/proekty/dom-1')

    expect(text).toContain('<b>Новая заявка: Контактная форма</b>')
    expect(text).toContain('👤 <b>Имя:</b> Иван')
    expect(text).toContain('📞 <b>Телефон:</b> +79991112233')
    expect(text).toContain('💬 <b>Сообщение:</b>\nТест')
    expect(text).toContain('• <b>Удобное время:</b> после 18:00')
    expect(text).toContain('🔗 <b>Страница:</b> https://taurusdom.ru/proekty/dom-1')
    expect(text).toContain('💻 Компьютер')
    expect(text).not.toMatch(/<h[2-6]|<ul|<li/)
  })

  it('экранирует HTML в пользовательских полях', () => {
    const text = formatMaxMessage({
      ...baseFormData,
      name: '<b>Хакер</b>',
      message: '<a href="https://evil.example">жми</a> & всё',
      fields: { note: '<script>x</script>' },
      field_meta: { note: { label: 'Метка <i>' } },
    } as unknown as FormData, 'https://site.ru/?a=1&b="x"')

    expect(text).toContain('&lt;b&gt;Хакер&lt;/b&gt;')
    expect(text).toContain('&lt;a href="https://evil.example"&gt;жми&lt;/a&gt; &amp; всё')
    expect(text).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(text).toContain('Метка &lt;i&gt;')
    expect(text).not.toContain('<a href="https://evil.example"')
    expect(text).toContain('https://site.ru/?a=1&amp;b="x"')
  })

  it('url вложения из тела запроса — только текстом, свои файлы — ссылкой', () => {
    const data = {
      ...baseFormData,
      attachments: [
        { name: 'plan.pdf', size: 10, status: 'uploaded', id: 'f1', mimeType: 'application/pdf' },
        { name: 'foto.jpg', size: 10, status: 'uploaded', url: 'https://evil.example/"><a href="x">', mimeType: 'image/jpeg' },
        { name: 'big.zip', size: 10, status: 'failed', reason: 'слишком <большой>' },
      ],
    } as unknown as FormData

    const text = formatMaxMessage(data, undefined, [
      { id: 'f1', name: 'plan.pdf', url: 'https://files.site.ru/abc.pdf' },
    ])

    expect(text).toContain('• <a href="https://files.site.ru/abc.pdf">plan.pdf</a>')
    expect(text).toContain('• foto.jpg (https://evil.example/"&gt;&lt;a href="x"&gt;)')
    expect(text).not.toContain('<a href="x">')
    expect(text).toContain('• big.zip — слишком &lt;большой&gt;')
  })

  it('калькулятор: параметры, итог без «телефонной» разбивки, ссылка на проект', () => {
    const data = {
      ...baseFormData,
      type: 'calculator',
      calculator_data: {
        selection: { timber: { label: 'Брус 150×150' }, roof: { label: 'Металлочерепица' } },
        total: { value: 1500000 },
        project: { article: 'Т-12', size: '8×10' },
      },
    } as unknown as FormData

    const text = formatMaxMessage(data, 'https://taurusdom.ru/proekty/t-12?x="1"')

    expect(text).toContain('<b>Новая заявка: Расчет проекта</b>')
    expect(text).toContain('• Материал стен: Брус 150×150')
    expect(text).toContain('💰 <b>Итого: 1 500 000 ₽</b>')
    expect(text).toContain('🏠 <a href="https://taurusdom.ru/proekty/t-12?x=&quot;1&quot;">Проект Т-12 (8×10)</a>')
  })

  it('не делает ссылку из source_url с не-http схемой', () => {
    const data = {
      ...baseFormData,
      type: 'calculator',
      calculator_data: { selection: {}, project: { title: 'Дом' } },
    } as unknown as FormData

    const text = formatMaxMessage(data, 'javascript:alert(1)')
    expect(text).toContain('🏠 Дом')
    expect(text).not.toContain('javascript:')
  })

  it('длинный текст режется до лимита по границе строки, разметка не рвётся', () => {
    const fields: Record<string, string> = {}
    for (let i = 0; i < 15; i++) fields[`f${i}`] = 'я'.repeat(200)
    const text = formatMaxMessage({
      ...baseFormData,
      message: `${'строка сообщения\n'.repeat(160)}`,
      fields,
    } as unknown as FormData)

    expect(text.length).toBeLessThanOrEqual(3900)
    expect(text.endsWith('\n…')).toBe(true)
    const opened = (text.match(/<b>/g) || []).length
    const closed = (text.match(/<\/b>/g) || []).length
    expect(opened).toBe(closed)
  })
})

describe('protectPrices', () => {
  it('меняет разделители разрядов в суммах на U+202F', () => {
    expect(protectPrices('Итого: 1 500 000 ₽')).toBe('Итого: 1 500 000 ₽')
    expect(protectPrices('350 000 руб.')).toBe('350 000 руб.')
  })

  it('не трогает телефоны и числа без валюты', () => {
    expect(protectPrices('+7 999 111 22 33')).toBe('+7 999 111 22 33')
    expect(protectPrices('площадь 1 200 м²')).toBe('площадь 1 200 м²')
  })
})

describe('sendMaxNotification', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    process.env.MAX_BOT_TOKEN = TOKEN
    process.env.MAX_CHAT_IDS = '-73283938180439'
  })

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch)
    vi.restoreAllMocks()
    delete process.env.MAX_BOT_TOKEN
    delete process.env.MAX_CHAT_IDS
    delete process.env.MAX_USER_IDS
    delete process.env.MAX_API_BASE
  })

  it('без токена тихо пропускает', async () => {
    delete process.env.MAX_BOT_TOKEN

    const result = await sendMaxNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('без получателей тихо пропускает', async () => {
    delete process.env.MAX_CHAT_IDS
    process.env.MAX_USER_IDS = ' , abc'

    const result = await sendMaxNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('шлёт POST /messages с голым токеном в Authorization и format=html', async () => {
    fetchMock.mockResolvedValue(okResponse())

    const result = await sendMaxNotification(baseFormData, 'sub-1', 'https://taurusdom.ru/')

    expect(result).toEqual({ sent: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://botapi.max.ru/messages?chat_id=-73283938180439&disable_link_preview=true')
    expect(String(url)).not.toContain(TOKEN)
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe(TOKEN)

    const body = JSON.parse(init.body)
    expect(body.format).toBe('html')
    expect(body.text).toContain('<b>Новая заявка: Контактная форма</b>')
    expect(body.text.length).toBeLessThanOrEqual(4000)
  })

  it('берёт базу API из MAX_API_BASE', async () => {
    process.env.MAX_API_BASE = 'https://platform-api2.max.ru/'
    fetchMock.mockResolvedValue(okResponse())

    await sendMaxNotification(baseFormData, 'sub-1')

    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/platform-api2\.max\.ru\/messages\?/)
  })

  it('несколько получателей: чаты и личные, без дублей', async () => {
    process.env.MAX_CHAT_IDS = '-100, -200 ,-100'
    process.env.MAX_USER_IDS = '555'
    fetchMock.mockResolvedValue(okResponse())

    const result = await sendMaxNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: true })
    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls).toHaveLength(3)
    expect(urls[0]).toContain('chat_id=-100')
    expect(urls[1]).toContain('chat_id=-200')
    expect(urls[2]).toContain('user_id=555')
  })

  it('один получатель упал — остальные получают, sent=true', async () => {
    process.env.MAX_CHAT_IDS = '-100,-200'
    fetchMock
      .mockResolvedValueOnce(errorResponse(403, { code: 'chat.denied', message: 'no access' }))
      .mockResolvedValueOnce(okResponse())
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await sendMaxNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('ошибка API: sent=false, токен не попадает в логи', async () => {
    fetchMock.mockResolvedValue(errorResponse(401, {
      code: 'verify.token',
      message: `Invalid access_token: ${TOKEN}`,
    }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await sendMaxNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: false })
    const logs = allLogs(error, warn, log)
    expect(logs).toContain('HTTP 401')
    expect(logs).toContain('verify.token')
    expect(logs).not.toContain(TOKEN)
  })

  it('сетевая ошибка: sent=false, токен не попадает в логи', async () => {
    fetchMock.mockRejectedValue(new Error(`connect ECONNREFUSED (auth ${TOKEN})`))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await sendMaxNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: false })
    const logs = allLogs(error)
    expect(logs).toContain('ECONNREFUSED')
    expect(logs).not.toContain(TOKEN)
  })

  it('400 на разметку — повтор простым текстом без тегов', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(400, { code: 'proto.payload', message: 'bad html' }))
      .mockResolvedValueOnce(okResponse())
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await sendMaxNotification({ ...baseFormData, name: 'Иван & Ко' } as FormData, 'sub-1')

    expect(result).toEqual({ sent: true })
    const retry = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(retry.format).toBeUndefined()
    expect(retry.text).not.toMatch(/<\/?b>/)
    expect(retry.text).toContain('Иван & Ко')
  })

  it('429 — одна повторная попытка через секунду', async () => {
    vi.useFakeTimers()
    try {
      fetchMock
        .mockResolvedValueOnce(errorResponse(429, { code: 'too.many.requests' }))
        .mockResolvedValueOnce(okResponse())

      const pending = sendMaxNotification(baseFormData, 'sub-1')
      await vi.advanceTimersByTimeAsync(1000)
      const result = await pending

      expect(result).toEqual({ sent: true })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('вложения — ссылками на файлы из directus_files', async () => {
    process.env.PUBLIC_FILES_URL = 'https://files.taurusdom.ru'
    fetchMock.mockResolvedValue(okResponse())

    const directusContext = {
      getSchema: async () => ({}),
      services: {
        ItemsService: class {
          readOne = vi.fn(async () => ({ filename_disk: 'abc.pdf' }))
        },
      },
    }

    try {
      const data = {
        ...baseFormData,
        attachments: [{ name: 'plan.pdf', size: 1, status: 'uploaded', id: 'f1', mimeType: 'application/pdf' }],
      } as unknown as FormData

      await sendMaxNotification(data, 'sub-1', undefined, directusContext)

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.text).toContain('<a href="https://files.taurusdom.ru/abc.pdf">plan.pdf</a>')
    }
    finally {
      delete process.env.PUBLIC_FILES_URL
    }
  })
})
