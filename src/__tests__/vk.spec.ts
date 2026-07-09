import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendVkNotification } from '../vk.js'
import type { FormData } from '../validation.js'

const baseFormData: FormData = {
  form_key: 'test',
  form_title: 'Test Form',
  type: 'contact',
  device: 'desktop',
  attachments: [],
  fields: { name: 'Иван', phone: '+79991112233' },
  field_meta: {},
  name: 'Иван',
  phone: '+79991112233',
  email: null,
  message: 'Тест',
  agree: true,
} as unknown as FormData

describe('sendVkNotification', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    process.env.VK_GROUP_TOKEN = 'test-vk-token'
    process.env.VK_ADMIN_IDS = '999'
  })

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch)
    delete process.env.VK_GROUP_TOKEN
    delete process.env.VK_ADMIN_IDS
    delete process.env.VK_CLIENT_IDS
  })

  it('возвращает { sent: false } если token не задан', async () => {
    delete process.env.VK_GROUP_TOKEN

    const result = await sendVkNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('возвращает { sent: false } если peer IDs пустые', async () => {
    delete process.env.VK_ADMIN_IDS

    const result = await sendVkNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('отправляет messages.send без keyboard (кнопки удалены в ih1)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ response: [{ peer_id: 999, message_id: 1, conversation_message_id: 1 }] }),
    })

    const result = await sendVkNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: true })

    const sendCall = fetchMock.mock.calls.find(([url]) => String(url).includes('messages.send'))
    expect(sendCall).toBeTruthy()

    const body = sendCall![1].body as string
    expect(body).toContain('peer_ids=999')
    expect(body).not.toContain('keyboard')
    expect(body).not.toContain('form_processed')
    expect(body).not.toContain('form_spam')
  })

  it('result не содержит messages array (удалено в ih1)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ response: [{ peer_id: 999, message_id: 1, conversation_message_id: 1 }] }),
    })

    const result = await sendVkNotification(baseFormData, 'sub-1')

    expect(result).not.toHaveProperty('messages')
    expect(Object.keys(result)).toEqual(['sent'])
  })

  it('возвращает { sent: false } если VK API возвращает error', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ error: { error_code: 100, error_msg: 'invalid token' } }),
    })

    const result = await sendVkNotification(baseFormData, 'sub-1')

    expect(result).toEqual({ sent: false })
  })
})
