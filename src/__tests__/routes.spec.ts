/**
 * Маршруты заявок (routes.ts) и доставка по маршруту (routing.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DELIVERY_STATUS_FIELD,
  ROUTES_COLLECTION,
  ensureRoutesSchema,
  findActiveRoute,
  normalizeRoute,
  parseEmails,
  parseTelegramChatIds,
  routesEnabled,
  type FormRoute,
} from '../routes.js'
import { buildOwnerNote, deliverByRoute, formatDeliveryStatus, type TenantSenders } from '../routing.js'

function ctxWith(rows: any[] | (() => never), collections: Record<string, any> = { [ROUTES_COLLECTION]: { fields: {} } }) {
  const readByQuery = vi.fn(async () => {
    if (typeof rows === 'function') rows()
    return rows
  })
  return {
    readByQuery,
    ctx: {
      services: { ItemsService: class { readByQuery = readByQuery } },
      getSchema: async () => ({ collections }),
    },
  }
}

const baseRow = {
  id: 1,
  form_key: 'rent-masterkrysha',
  active: true,
  tenant_name: 'ИП Кровлин',
  emails: ['Tenant@Example.ru', 'bad-address', 'tenant@example.ru'],
  max_user_ids: ['123456', 'abc'],
  max_chat_ids: null,
  telegram_chat_ids: '-1001234567890, @krovlin_leads',
  copy_to_owner: true,
}

describe('routesEnabled', () => {
  it('выключено по умолчанию', () => {
    expect(routesEnabled({})).toBe(false)
    expect(routesEnabled({ FORMS_ROUTES_ENABLED: '1' })).toBe(false)
    expect(routesEnabled({ FORMS_ROUTES_ENABLED: 'true' })).toBe(true)
  })
})

describe('normalizeRoute', () => {
  it('чистит и дедуплицирует получателей', () => {
    const route = normalizeRoute(baseRow)!
    expect(route.emails).toEqual(['tenant@example.ru'])
    expect(route.max_user_ids).toEqual(['123456'])
    expect(route.max_chat_ids).toEqual([])
    expect(route.telegram_chat_ids).toEqual(['-1001234567890', '@krovlin_leads'])
  })

  it('copy_to_owner по умолчанию true, выключается только явным false', () => {
    expect(normalizeRoute({ ...baseRow, copy_to_owner: null })!.copy_to_owner).toBe(true)
    expect(normalizeRoute({ ...baseRow, copy_to_owner: false })!.copy_to_owner).toBe(false)
  })

  it('отбрасывает адреса с переводом строки (header injection)', () => {
    expect(parseEmails(['a@b.ru\r\nBcc: x@y.ru', 'ok@b.ru'])).toEqual(['ok@b.ru'])
    expect(parseTelegramChatIds(['12; DROP', '42'])).toEqual(['42'])
  })
})

describe('findActiveRoute', () => {
  it('нет коллекции form_routes — null (прежнее поведение)', async () => {
    const { ctx, readByQuery } = ctxWith([baseRow], {})
    expect(await findActiveRoute('rent-masterkrysha', ctx)).toBeNull()
    expect(readByQuery).not.toHaveBeenCalled()
  })

  it('нет записи для form_key — null', async () => {
    const { ctx, readByQuery } = ctxWith([])
    expect(await findActiveRoute('rent-other', ctx)).toBeNull()
    expect(readByQuery).toHaveBeenCalledWith(expect.objectContaining({ filter: { form_key: { _eq: 'rent-other' } }, limit: 1 }))
  })

  it('запись выключена — null', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ctx } = ctxWith([{ ...baseRow, active: false }])
    expect(await findActiveRoute('rent-masterkrysha', ctx)).toBeNull()
  })

  it('в записи нет валидных получателей — null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = ctxWith([{ ...baseRow, emails: ['nope'], max_user_ids: [], telegram_chat_ids: [] }])
    expect(await findActiveRoute('rent-masterkrysha', ctx)).toBeNull()
  })

  it('ошибка чтения — null, заявка не теряется', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ctx } = ctxWith(() => { throw new Error('db down') })
    expect(await findActiveRoute('rent-masterkrysha', ctx)).toBeNull()
  })

  it('активная запись — маршрут', async () => {
    const { ctx } = ctxWith([baseRow])
    const route = await findActiveRoute('rent-masterkrysha', ctx)
    expect(route).toMatchObject({ form_key: 'rent-masterkrysha', tenant_name: 'ИП Кровлин', emails: ['tenant@example.ru'] })
  })

  afterEach(() => vi.restoreAllMocks())
})

describe('ensureRoutesSchema', () => {
  function setup(collections: Record<string, any>) {
    const createOne = vi.fn(async () => ROUTES_COLLECTION)
    const createField = vi.fn(async () => {})
    const ctx = {
      services: {
        CollectionsService: class { createOne = createOne },
        FieldsService: class { createField = createField },
      },
      getSchema: async () => ({ collections }),
    }
    return { ctx, createOne, createField }
  }

  it('создаёт коллекцию и поле delivery_status, если их нет', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ctx, createOne, createField } = setup({ lead_submissions: { fields: { id: {} } } })
    await ensureRoutesSchema(ctx, 'lead_submissions')
    expect(createOne).toHaveBeenCalledWith(expect.objectContaining({ collection: ROUTES_COLLECTION }))
    const definition = (createOne.mock.calls[0] as any[])[0]
    expect(definition.fields.map((f: any) => f.field)).toEqual(expect.arrayContaining([
      'form_key', 'active', 'tenant_name', 'emails', 'max_user_ids', 'max_chat_ids', 'telegram_chat_ids', 'copy_to_owner', 'note',
    ]))
    expect(definition.fields.find((f: any) => f.field === 'form_key').schema.is_unique).toBe(true)
    expect(definition.fields.find((f: any) => f.field === 'copy_to_owner').schema.default_value).toBe(true)
    expect(createField).toHaveBeenCalledWith('lead_submissions', expect.objectContaining({ field: DELIVERY_STATUS_FIELD, type: 'text' }))
  })

  it('ничего не трогает, если всё уже есть', async () => {
    const { ctx, createOne, createField } = setup({
      [ROUTES_COLLECTION]: { fields: {} },
      lead_submissions: { fields: { [DELIVERY_STATUS_FIELD]: {} } },
    })
    await ensureRoutesSchema(ctx, 'lead_submissions')
    expect(createOne).not.toHaveBeenCalled()
    expect(createField).not.toHaveBeenCalled()
  })

  afterEach(() => vi.restoreAllMocks())
})

describe('deliverByRoute — кому уходит заявка', () => {
  const route: FormRoute = {
    id: 1,
    form_key: 'rent-masterkrysha',
    tenant_name: 'ИП Кровлин',
    emails: ['tenant@example.ru'],
    telegram_chat_ids: [],
    max_user_ids: ['123456'],
    max_chat_ids: [],
    copy_to_owner: true,
  }

  function senders(overrides: Partial<Record<keyof TenantSenders, any>> = {}) {
    return {
      email: vi.fn(overrides.email ?? (async () => ({ ok: true }))),
      telegram: vi.fn(overrides.telegram ?? (async () => ({ ok: true }))),
      max: vi.fn(overrides.max ?? (async () => ({ ok: true }))),
    }
  }

  it('арендатору — только его каналы, получатели из маршрута; копия нам при copy_to_owner', async () => {
    const s = senders()
    const owner = vi.fn(async () => ({ telegram: true, vk: false, email: true }))
    const report = await deliverByRoute(route, s, owner)

    expect(s.email).toHaveBeenCalledWith(['tenant@example.ru'])
    expect(s.max).toHaveBeenCalledWith([{ kind: 'user_id', id: '123456' }])
    expect(s.telegram).not.toHaveBeenCalled()
    expect(owner).toHaveBeenCalledTimes(1)
    expect((owner.mock.calls[0] as any[])[0]).toMatch(/^Копия: заявка ушла арендатору «ИП Кровлин»/)
    expect(report.tenant_ok).toBe(true)
    expect(report.owner).toEqual({ mode: 'copy', channels: { telegram: true, vk: false, email: true } })
  })

  it('copy_to_owner=false и арендатору ушло — нам ничего', async () => {
    const owner = vi.fn(async () => ({}))
    const report = await deliverByRoute({ ...route, copy_to_owner: false }, senders(), owner)
    expect(owner).not.toHaveBeenCalled()
    expect(report.owner.mode).toBe('off')
  })

  it('copy_to_owner=false, но арендатору не ушло ни по одному каналу — заявка приходит нам', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = senders({
      email: async () => ({ ok: false, error: 'SMTP 550' }),
      max: async () => { throw new Error('network down') },
    })
    const owner = vi.fn(async () => ({ email: true }))
    const report = await deliverByRoute({ ...route, copy_to_owner: false }, s, owner)

    expect(owner).toHaveBeenCalledTimes(1)
    expect((owner.mock.calls[0] as any[])[0]).toMatch(/НЕ доставлена/)
    expect(report.owner.mode).toBe('fallback')
    expect(report.tenant.email).toEqual({ ok: false, to: ['tenant@example.ru'], error: 'SMTP 550' })
    expect(report.tenant.max).toEqual({ ok: false, to: ['user:123456'], error: 'network down' })
  })

  it('сбой одного канала арендатора не мешает другому', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = senders({ email: async () => { throw new Error('smtp timeout') } })
    const report = await deliverByRoute(route, s, async () => ({}))
    expect(report.tenant.max?.ok).toBe(true)
    expect(report.tenant.email?.ok).toBe(false)
    expect(report.tenant_ok).toBe(true)
  })

  it('formatDeliveryStatus — читаемый журнал', async () => {
    const report = await deliverByRoute(route, senders({ max: async () => ({ ok: false, error: 'user 123456: HTTP 403' }) }), async () => ({ telegram: true, email: false }))
    expect(formatDeliveryStatus(report)).toBe([
      'Маршрут rent-masterkrysha → ИП Кровлин',
      'Почта tenant@example.ru: ✓',
      'MAX user:123456: ✗ user 123456: HTTP 403',
      'Копия нам: Telegram ✓, почта ✗',
    ].join('\n'))
  })

  it('buildOwnerNote без имени арендатора', () => {
    expect(buildOwnerNote({ ...route, tenant_name: '' }, { email: { ok: true, to: ['a@b.ru'] } }, 'copy'))
      .toBe('Копия: заявка ушла арендатору по маршруту rent-masterkrysha (почта a@b.ru — ушло).')
  })

  afterEach(() => vi.restoreAllMocks())
})
