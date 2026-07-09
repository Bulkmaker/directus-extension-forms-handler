import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendTelegramNotification } from '../telegram.js'
import type { FormData } from '../validation.js'

const baseFormData: FormData = {
  form_key: 'test',
  form_title: 'Test Form',
  type: 'contact',
  device: 'desktop',
  attachments: [],
  fields: { name: 'Иван', phone: '+79991112233', message: 'Тест' },
  field_meta: {},
  name: 'Иван',
  phone: '+79991112233',
  email: null,
  message: 'Тест',
  agree: true,
} as unknown as FormData

describe('sendTelegramNotification', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    process.env.TG_LEADS_BOT_TOKEN = 'test-token'
    process.env.TG_LEADS_CHAT_IDS = '12345'
    process.env.FORMS_TELEGRAM_ENABLED = 'true'
  })

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch)
    delete process.env.TG_LEADS_BOT_TOKEN
    delete process.env.TG_LEADS_CHAT_IDS
    delete process.env.FORMS_TELEGRAM_ENABLED
  })

  it('возвращает { sent: false } если FORMS_TELEGRAM_ENABLED != true', async () => {
    delete process.env.FORMS_TELEGRAM_ENABLED

    const result = await sendTelegramNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('возвращает { sent: false } если bot token не задан', async () => {
    delete process.env.TG_LEADS_BOT_TOKEN

    const result = await sendTelegramNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('возвращает { sent: false } если chat IDs не заданы', async () => {
    delete process.env.TG_LEADS_CHAT_IDS

    const result = await sendTelegramNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('отправляет sendRichMessage (без картинок — это дефолтный путь)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 100 } }),
    })

    const result = await sendTelegramNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toContain('/sendRichMessage')
    const body = JSON.parse(options.body)
    expect(body.chat_id).toBe('12345')
    expect(body.rich_message.markdown).toContain('Иван')
    expect(body.rich_message.skip_entity_detection).toBe(true)
    expect(body.rich_message.markdown).not.toContain('form_processed')
    expect(body.rich_message.markdown).not.toContain('form_spam')
  })

  it('падает обратно на sendMessage/HTML, если sendRichMessage вернул ошибку', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, description: 'rich message unsupported' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 101 } }),
      })

    const result = await sendTelegramNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const [firstUrl] = fetchMock.mock.calls[0]
    const [secondUrl, secondOptions] = fetchMock.mock.calls[1]
    expect(firstUrl).toContain('/sendRichMessage')
    expect(secondUrl).toContain('/sendMessage')
    const body = JSON.parse(secondOptions.body)
    expect(body.text).toContain('Иван')
    expect(body.parse_mode).toBe('HTML')
  })

  it('падает обратно на sendMessage/HTML, если sendRichMessage бросил сетевую ошибку (не ok:false, а fetch throw)', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 102 } }),
      })

    const result = await sendTelegramNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [secondUrl] = fetchMock.mock.calls[1]
    expect(secondUrl).toContain('/sendMessage')
  })

  it('экранирует markdown-спецсимволы и не даёт голому URL в тексте стать ссылкой', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 100 } }),
    })

    const maliciousData = {
      ...baseFormData,
      name: 'Вася [кликни](https://evil.example) *жир*',
      message: 'зайдите на https://evil.example пожалуйста',
    } as unknown as FormData

    await sendTelegramNotification(maliciousData, 'sub-1')

    const [, options] = fetchMock.mock.calls[0]
    const markdown = JSON.parse(options.body).rich_message.markdown
    expect(markdown).toContain('\\[кликни\\]\\(https://evil.example\\)')
    expect(markdown).toContain('\\*жир\\*')
  })

  it('строит markdown-таблицу из "Label: value" строк message (напр. калькулятор)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 100 } }),
    })

    const calcData = {
      ...baseFormData,
      message: 'Материал: Брус 150×150\nФундамент: Свайный\nСтоимость дома: 1 500 000 ₽',
      fields: { ...baseFormData.fields, totalPrice: 1500000 },
    } as unknown as FormData

    await sendTelegramNotification(calcData, 'sub-1')

    const [, options] = fetchMock.mock.calls[0]
    const markdown = JSON.parse(options.body).rich_message.markdown
    expect(markdown).toContain('| Материал | Брус 150×150 |')
    expect(markdown).toContain('| Фундамент | Свайный |')
  })

  it('сворачивает Проект/Размер/Площадь в одну строку-ссылку, цену выносит в цитату-блок', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 100 } }),
    })

    const calcData = {
      ...baseFormData,
      message: 'Проект: ДБ-04\nРазмер: 8x8\nПлощадь: 119 м²\nСтены: Брус\nСтоимость дома: 1 500 000 ₽',
    } as unknown as FormData

    await sendTelegramNotification(calcData, 'sub-1', 'https://example.com/catalog/db-04')

    const [, options] = fetchMock.mock.calls[0]
    const markdown = JSON.parse(options.body).rich_message.markdown
    expect(markdown).toContain(
      '| Проект | [ДБ-04](https://example.com/catalog/db-04)<br>8x8 · 119 м² |',
    )
    // Размер/Площадь/Стоимость дома не остаются отдельными строками таблицы
    expect(markdown).not.toContain('| Размер |')
    expect(markdown).not.toContain('| Площадь |')
    expect(markdown).not.toContain('| Стоимость дома |')
    expect(markdown).toContain('| Стены | Брус |')
    // Цена — отдельным блоком-цитатой с заголовком 3-го уровня
    expect(markdown).toContain('> ### 1 500 000 ₽')
    // totalPrice не дублируется отдельным raw-полем
    expect(markdown).not.toContain('totalPrice')
  })

  it('пишет "Цена по запросу" в цитате, если строки "Стоимость дома" нет вовсе', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 100 } }),
    })

    const onRequestData = {
      ...baseFormData,
      message: 'Проект: ДБ-04\nРазмер: 8x8\nСтены: Брус\n(Точная цена будет рассчитана после заявки)',
    } as unknown as FormData

    await sendTelegramNotification(onRequestData, 'sub-1')

    const [, options] = fetchMock.mock.calls[0]
    const markdown = JSON.parse(options.body).rich_message.markdown
    expect(markdown).toContain('> ### Цена по запросу')
  })

  it('email — кликабельная mailto-ссылка', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 100 } }),
    })

    const dataWithEmail = { ...baseFormData, email: 'ivan@example.com' } as unknown as FormData
    await sendTelegramNotification(dataWithEmail, 'sub-1')

    const [, options] = fetchMock.mock.calls[0]
    const markdown = JSON.parse(options.body).rich_message.markdown
    expect(markdown).toContain('[ivan@example.com](mailto:ivan@example.com)')
  })

  it('возвращает { sent: false } если все chats fail (Telegram api error)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, description: 'chat not found' }),
    })

    const result = await sendTelegramNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: false })
  })

  it('возвращает { sent: true } если хотя бы один chat успешен', async () => {
    process.env.TG_LEADS_CHAT_IDS = '12345,67890'

    fetchMock
      // chat 12345: rich fails, HTML fallback тоже fails
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: false, description: 'rich fail' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: false, description: 'fallback fail' }) })
      // chat 67890: rich succeeds сразу
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, result: { message_id: 200 } }) })

    const result = await sendTelegramNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('result не содержит messages array (удалено в ih1)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 100 } }),
    })

    const result = await sendTelegramNotification(baseFormData, 'sub-1')

    expect(result).not.toHaveProperty('messages')
    expect(Object.keys(result)).toEqual(['sent'])
  })
})
