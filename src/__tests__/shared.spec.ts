import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isImageMimeType,
  escapeHtml,
  formatUnknownValue,
  getFormTypeLabel,
  extractCustomFields,
  parseCalculatorData,
  splitLabeledMessage,
  formatPrice,
  formatShortDate,
  downloadFile,
  MAX_DOWNLOAD_BYTES,
  resolveAttachmentUrls,
} from '../shared.js'
import type { FormData } from '../validation.js'

function makeFormData(overrides: Partial<FormData> = {}): FormData {
  return {
    form_key: 'contact',
    form_title: 'Контактная форма',
    type: 'contact',
    name: 'Иван',
    phone: '+79991234567',
    agree: true,
    fields: {},
    attachments: [],
    ...overrides,
  } as FormData
}

describe('isImageMimeType', () => {
  it('распознаёт image/jpeg / png / webp / gif', () => {
    expect(isImageMimeType('image/jpeg')).toBe(true)
    expect(isImageMimeType('image/png')).toBe(true)
    expect(isImageMimeType('image/webp')).toBe(true)
    expect(isImageMimeType('image/gif')).toBe(true)
  })
  it('case-insensitive', () => {
    expect(isImageMimeType('IMAGE/JPEG')).toBe(true)
  })
  it('false для PDF и без типа', () => {
    expect(isImageMimeType('application/pdf')).toBe(false)
    expect(isImageMimeType(undefined)).toBe(false)
    expect(isImageMimeType('')).toBe(false)
  })
})

describe('escapeHtml', () => {
  it('экранирует <, >, & (XSS-prevention)', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert("x")&lt;/script&gt;')
    expect(escapeHtml('A & B')).toBe('A &amp; B')
  })
})

describe('formatUnknownValue', () => {
  it('null/undefined → "—"', () => {
    expect(formatUnknownValue(null)).toBe('—')
    expect(formatUnknownValue(undefined)).toBe('—')
  })
  it('пропускает короткие строки', () => {
    expect(formatUnknownValue('hello')).toBe('hello')
  })
  it('обрезает длинные строки до 200 символов с ellipsis', () => {
    const long = 'x'.repeat(250)
    const out = formatUnknownValue(long)
    expect(out.length).toBeLessThanOrEqual(201)
    expect(out.endsWith('…')).toBe(true)
  })
  it('форматирует числа и булевы', () => {
    expect(formatUnknownValue(42)).toBe('42')
    expect(formatUnknownValue(true)).toBe('true')
  })
  it('массивы до 4 элементов — список через запятую', () => {
    expect(formatUnknownValue([1, 2, 3])).toBe('1, 2, 3')
  })
  it('массивы > 4 — первые 4 + счётчик', () => {
    expect(formatUnknownValue([1, 2, 3, 4, 5, 6])).toBe('1, 2, 3, 4 (+2)')
  })
  it('объекты сериализуются через JSON', () => {
    expect(formatUnknownValue({ a: 1 })).toBe('{"a":1}')
  })
})

describe('getFormTypeLabel', () => {
  it('contact → "Контактная форма"', () => {
    expect(getFormTypeLabel(makeFormData({ type: 'contact' }))).toBe('Контактная форма')
  })
  it('calculator → "Расчет проекта"', () => {
    expect(getFormTypeLabel(makeFormData({ type: 'calculator' }))).toBe('Расчет проекта')
  })
  it('неизвестный type → form_title или form_key', () => {
    expect(getFormTypeLabel(makeFormData({ type: 'custom', form_title: 'Спец-форма' }))).toBe('Спец-форма')
    expect(getFormTypeLabel(makeFormData({ type: 'custom', form_title: null, form_key: 'special' }))).toBe('special')
  })
})

describe('extractCustomFields', () => {
  it('пропускает known/technical поля', () => {
    const data = makeFormData({
      fields: { name: 'X', phone: '+7', custom_field: 'value' },
    })
    const result = extractCustomFields(data)
    expect(result).toEqual([{ key: 'custom_field', label: 'custom_field', value: 'value' }])
  })

  it('использует label из field_meta', () => {
    const data = makeFormData({
      fields: { area: 120 },
      field_meta: { area: { label: 'Площадь м²' } },
    })
    expect(extractCustomFields(data)).toEqual([
      { key: 'area', label: 'Площадь м²', value: '120' },
    ])
  })

  it('ограничивает количество полей (maxFields)', () => {
    const fields: Record<string, unknown> = {}
    for (let i = 0; i < 20; i++) fields[`f${i}`] = i
    const result = extractCustomFields(makeFormData({ fields }), 5)
    expect(result).toHaveLength(5)
  })

  it('пустой массив если нет custom-полей', () => {
    expect(extractCustomFields(makeFormData({ fields: { name: 'X' } }))).toEqual([])
  })

  it('пропускает поля со значением-объектом (напр. project/selection калькулятора) — не дублировать сырой JSON', () => {
    const data = makeFormData({
      fields: {
        project: { id: 5, title: 'ДБ-04' },
        selection: { timber: { label: 'Брус' } },
        totalPrice: 1500000,
      },
    })
    expect(extractCustomFields(data)).toEqual([
      { key: 'totalPrice', label: 'totalPrice', value: '1500000' },
    ])
  })
})

describe('splitLabeledMessage', () => {
  it('разбирает "Label: value" строки в rows', () => {
    const message = 'Материал: Брус 150×150\nФундамент: Свайный'
    expect(splitLabeledMessage(message)).toEqual({
      rows: [
        { label: 'Материал', value: 'Брус 150×150' },
        { label: 'Фундамент', value: 'Свайный' },
      ],
      extra: [],
    })
  })

  it('строки без ":" уходят в extra', () => {
    const message = 'Материал: Брус\n(Точная цена по запросу)\nПросто текст без метки'
    const result = splitLabeledMessage(message)
    expect(result.rows).toEqual([{ label: 'Материал', value: 'Брус' }])
    expect(result.extra).toEqual(['(Точная цена по запросу)', 'Просто текст без метки'])
  })

  it('игнорирует пустые строки', () => {
    const message = 'Материал: Брус\n\n\nФундамент: Свайный'
    expect(splitLabeledMessage(message).rows).toHaveLength(2)
  })

  it('длинный "label" (>60 символов до ":") не считается меткой — это скорее предложение с двоеточием', () => {
    const longSentence = `${'x'.repeat(70)}: значение`
    const result = splitLabeledMessage(longSentence)
    expect(result.rows).toEqual([])
    expect(result.extra).toEqual([longSentence])
  })
})

describe('parseCalculatorData', () => {
  it('null если calculator_data отсутствует', () => {
    expect(parseCalculatorData(makeFormData())).toBeNull()
  })
  it('null если selection нет', () => {
    expect(parseCalculatorData(makeFormData({ calculator_data: { foo: 'bar' } }))).toBeNull()
  })
  it('валидные данные — возвращает объект', () => {
    const cd = { selection: { timber: { label: 'Брус 150×150', price: 100000 } } }
    const r = parseCalculatorData(makeFormData({ calculator_data: cd }))
    expect(r?.selection.timber?.label).toBe('Брус 150×150')
  })
})

describe('formatPrice', () => {
  it('форматирует число с пробелами как разделитель тысяч (ru-RU)', () => {
    //   — non-breaking space, который Intl.NumberFormat использует в ru-RU
    expect(formatPrice(1500000)).toBe('1 500 000')
    expect(formatPrice(99)).toBe('99')
  })
})

describe('formatShortDate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('возвращает русский короткий формат "DD ммм YYYY"', () => {
    vi.setSystemTime(new Date('2026-05-03T12:00:00Z'))
    expect(formatShortDate()).toMatch(/^\d{1,2} (янв|фев|мар|апр|май|июн|июл|авг|сен|окт|ноя|дек) 2026$/)
  })
})

describe('downloadFile', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // SSRF guard разрешает только PUBLIC_FILES_URL host — для тестов задаём 'x'.
    process.env.PUBLIC_FILES_URL = 'http://x'
  })

  afterEach(() => {
    delete process.env.PUBLIC_FILES_URL
  })

  it('возвращает Buffer на 200 OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-length': '3' },
    })))
    const buf = await downloadFile('http://x/y')
    expect(buf?.length).toBe(3)
  })

  it('null на non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    expect(await downloadFile('http://x/y')).toBeNull()
  })

  it('null если content-length > MAX', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(0), {
      status: 200,
      headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) },
    })))
    expect(await downloadFile('http://x/y')).toBeNull()
  })

  it('null при network-ошибке', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    expect(await downloadFile('http://x/y')).toBeNull()
  })
})

describe('resolveAttachmentUrls', () => {
  beforeEach(() => {
    process.env.PUBLIC_FILES_URL = 'https://files.test'
  })
  afterEach(() => {
    delete process.env.PUBLIC_FILES_URL
  })

  it('возвращает [] если PUBLIC_FILES_URL не задан', async () => {
    delete process.env.PUBLIC_FILES_URL
    const r = await resolveAttachmentUrls(
      [{ name: 'x.jpg', size: 1, status: 'uploaded', id: '1' }],
    )
    expect(r).toEqual([])
  })

  it('возвращает [] если нет успешных uploaded', async () => {
    const r = await resolveAttachmentUrls(
      [{ name: 'x.jpg', size: 1, status: 'failed' }],
    )
    expect(r).toEqual([])
  })

  it('возвращает [] если нет directusContext', async () => {
    const r = await resolveAttachmentUrls(
      [{ name: 'x.jpg', size: 1, status: 'uploaded', id: '1' }],
    )
    expect(r).toEqual([])
  })

  // Directus services используют конструкторы (`new ItemsService(...)`), а
  // vi.fn().mockImplementation не работает корректно с `new` в строгом режиме.
  // Поэтому ItemsService здесь — обычный класс.
  function makeCtx(readOne: ReturnType<typeof vi.fn>) {
    class ItemsService {
      readOne = readOne
      constructor(public collection: string) {}
    }
    return {
      services: { ItemsService },
      getSchema: vi.fn().mockResolvedValue({}),
    }
  }

  it('строит URL из filename_disk через ItemsService', async () => {
    const readOne = vi.fn().mockResolvedValue({ filename_disk: 'abc-x.jpg' })
    const r = await resolveAttachmentUrls(
      [{ name: 'photo.jpg', size: 100, status: 'uploaded', id: 'file-1', mimeType: 'image/jpeg' }],
      makeCtx(readOne),
    )
    expect(r).toEqual([
      { name: 'photo.jpg', url: 'https://files.test/abc-x.jpg', mimeType: 'image/jpeg' },
    ])
    expect(readOne).toHaveBeenCalledWith('file-1', { fields: ['filename_disk'] })
  })

  it('пропускает файл если readOne кинул ошибку, не падает', async () => {
    const readOne = vi.fn()
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ filename_disk: 'b.jpg' })
    const r = await resolveAttachmentUrls(
      [
        { name: 'a.jpg', size: 1, status: 'uploaded', id: 'fail' },
        { name: 'b.jpg', size: 1, status: 'uploaded', id: 'ok' },
      ],
      makeCtx(readOne),
    )
    expect(r).toHaveLength(1)
    expect(r[0].name).toBe('b.jpg')
  })

  it('обрабатывает максимум 10 файлов за раз', async () => {
    const readOne = vi.fn().mockResolvedValue({ filename_disk: 'x.jpg' })
    const attachments = Array.from({ length: 15 }, (_, i) => ({
      name: `${i}.jpg`,
      size: 1,
      status: 'uploaded' as const,
      id: String(i),
    }))
    const r = await resolveAttachmentUrls(attachments, makeCtx(readOne))
    expect(r).toHaveLength(10)
  })
})
