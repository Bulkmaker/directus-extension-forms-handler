/**
 * Маршруты заявок: form_key → получатели арендатора.
 *
 * Коллекция `form_routes` (создаётся расширением, если включено FORMS_ROUTES_ENABLED):
 * одна запись на форму сайта. Смена арендатора = правка записи в Directus, сайт не
 * пересобирается. Нет записи / запись выключена / в записи нет ни одного валидного
 * получателя — заявка идёт как раньше, в глобальные каналы из env.
 *
 * Права: коллекция создаётся без разрешений для ролей — читать и править её может
 * только администратор. Расширение читает её системным контекстом.
 */

export const ROUTES_COLLECTION = 'form_routes'
/** Человекочитаемый статус доставки в коллекции заявок (text, только чтение). */
export const DELIVERY_STATUS_FIELD = 'delivery_status'

export interface FormRoute {
  id: string | number
  form_key: string
  tenant_name: string
  emails: string[]
  max_user_ids: string[]
  max_chat_ids: string[]
  telegram_chat_ids: string[]
  copy_to_owner: boolean
}

export interface RoutesContext {
  services: any
  getSchema: () => Promise<any>
}

export function routesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FORMS_ROUTES_ENABLED === 'true'
}

// ——— Нормализация записи —————————————————————————————————————————————————

const EMAIL_RE = /^[^\s@<>"'(),;:\\[\]]+@[^\s@<>"'(),;:\\[\]]+\.[^\s@<>"'(),;:\\[\]]+$/
const NUMERIC_ID_RE = /^-?\d{1,20}$/
const TG_USERNAME_RE = /^@[A-Za-z0-9_]{5,32}$/

/** Список из json-массива (интерфейс tags) или строки через запятую/перенос. */
export function parseList(raw: unknown): string[] {
  let items: unknown[] = []
  if (Array.isArray(raw)) items = raw
  else if (typeof raw === 'string') items = raw.split(/[,;\n]+/)
  else if (typeof raw === 'number') items = [String(raw)]
  return items
    .map(item => (typeof item === 'number' ? String(item) : typeof item === 'string' ? item : ''))
    .map(item => item.trim())
    .filter(Boolean)
}

function uniq(items: string[], limit: number): string[] {
  return [...new Set(items)].slice(0, limit)
}

export function parseEmails(raw: unknown): string[] {
  return uniq(
    parseList(raw)
      .filter(item => !/[\r\n]/.test(item))
      .map(item => item.toLowerCase())
      .filter(item => item.length <= 254 && EMAIL_RE.test(item)),
    10,
  )
}

export function parseNumericIds(raw: unknown): string[] {
  return uniq(parseList(raw).filter(item => NUMERIC_ID_RE.test(item)), 20)
}

export function parseTelegramChatIds(raw: unknown): string[] {
  return uniq(parseList(raw).filter(item => NUMERIC_ID_RE.test(item) || TG_USERNAME_RE.test(item)), 20)
}

export function normalizeRoute(raw: any): FormRoute | null {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.form_key !== 'string' || !raw.form_key.trim()) return null
  return {
    id: raw.id,
    form_key: raw.form_key.trim(),
    tenant_name: typeof raw.tenant_name === 'string' ? raw.tenant_name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120) : '',
    emails: parseEmails(raw.emails),
    max_user_ids: parseNumericIds(raw.max_user_ids),
    max_chat_ids: parseNumericIds(raw.max_chat_ids),
    telegram_chat_ids: parseTelegramChatIds(raw.telegram_chat_ids),
    // По умолчанию копия владельцу сетки — выключается только явным false.
    copy_to_owner: raw.copy_to_owner !== false,
  }
}

export function routeHasRecipients(route: FormRoute): boolean {
  return route.emails.length > 0
    || route.telegram_chat_ids.length > 0
    || route.max_user_ids.length > 0
    || route.max_chat_ids.length > 0
}

// ——— Чтение маршрута ——————————————————————————————————————————————————

/**
 * Активный маршрут для form_key или null (→ прежнее поведение).
 * Ошибки чтения не бросает: заявку нельзя терять из-за маршрутов.
 */
export async function findActiveRoute(formKey: string | null | undefined, ctx: RoutesContext): Promise<FormRoute | null> {
  if (!formKey) return null
  try {
    const schema = await ctx.getSchema()
    if (!schema?.collections?.[ROUTES_COLLECTION]) return null

    const { ItemsService } = ctx.services
    const service = new ItemsService(ROUTES_COLLECTION, { schema, accountability: null })
    const rows = await service.readByQuery({
      filter: { form_key: { _eq: formKey } },
      limit: 1,
      fields: ['id', 'form_key', 'active', 'tenant_name', 'emails', 'max_user_ids', 'max_chat_ids', 'telegram_chat_ids', 'copy_to_owner'],
    })
    const raw = Array.isArray(rows) ? rows[0] : null
    if (!raw) return null
    if (raw.active !== true) {
      console.log(`[forms-handler] route ${formKey}: выключен — заявка идёт по глобальным каналам`)
      return null
    }
    const route = normalizeRoute(raw)
    if (!route) return null
    if (!routeHasRecipients(route)) {
      console.warn(`[forms-handler] route ${formKey}: нет ни одного валидного получателя — заявка идёт по глобальным каналам`)
      return null
    }
    return route
  }
  catch (err: any) {
    console.error(`[forms-handler] route ${formKey}: не удалось прочитать ${ROUTES_COLLECTION}, заявка идёт по глобальным каналам:`, err?.message || err)
    return null
  }
}

// ——— Создание коллекции ———————————————————————————————————————————————

function tagsField(field: string, note: string, placeholder: string) {
  return {
    field,
    type: 'json',
    meta: { interface: 'tags', special: ['cast-json'], width: 'half', note, options: { placeholder, alphabetize: false } },
    schema: { is_nullable: true },
  }
}

export const ROUTES_COLLECTION_DEFINITION = {
  collection: ROUTES_COLLECTION,
  meta: {
    icon: 'alt_route',
    note: 'Куда уходят заявки формы: form_key → получатели арендатора. Нет записи или выключена — заявки идут нам, как раньше.',
    display_template: '{{form_key}} → {{tenant_name}}',
    hidden: false,
    singleton: false,
  },
  schema: {},
  fields: [
    {
      field: 'id',
      type: 'integer',
      meta: { hidden: true, readonly: true, interface: 'input' },
      schema: { is_primary_key: true, has_auto_increment: true },
    },
    {
      field: 'form_key',
      type: 'string',
      meta: { interface: 'input', required: true, width: 'half', note: 'Точный form_key формы, например rent-masterkrysha', options: { placeholder: 'rent-masterkrysha', trim: true } },
      schema: { is_nullable: false, is_unique: true, max_length: 120 },
    },
    {
      field: 'active',
      type: 'boolean',
      meta: { interface: 'boolean', special: ['cast-boolean'], width: 'half', note: 'Выключено — заявки идут нам, как без маршрута' },
      schema: { is_nullable: false, default_value: true },
    },
    {
      field: 'tenant_name',
      type: 'string',
      meta: { interface: 'input', width: 'full', note: 'Арендатор (для журнала и копии владельцу)' },
      schema: { is_nullable: true, max_length: 255 },
    },
    tagsField('emails', 'Почта арендатора — по адресу на строку', 'mail@example.ru'),
    tagsField('telegram_chat_ids', 'Telegram: chat id арендатора (бот заявок должен быть в чате)', '123456789'),
    tagsField('max_user_ids', 'MAX: user id арендатора (он должен сначала написать боту)', '123456789'),
    tagsField('max_chat_ids', 'MAX: id чата/канала (бот — участник)', '-73283938180439'),
    {
      field: 'copy_to_owner',
      type: 'boolean',
      meta: { interface: 'boolean', special: ['cast-boolean'], width: 'half', note: 'Копия заявки нам (глобальные каналы)' },
      schema: { is_nullable: false, default_value: true },
    },
    {
      field: 'note',
      type: 'text',
      meta: { interface: 'input-multiline', width: 'full', note: 'Заметка: договор, срок аренды, контакты' },
      schema: { is_nullable: true },
    },
    {
      field: 'date_created',
      type: 'timestamp',
      meta: { special: ['date-created'], interface: 'datetime', readonly: true, hidden: true, width: 'half' },
      schema: { is_nullable: true },
    },
    {
      field: 'date_updated',
      type: 'timestamp',
      meta: { special: ['date-updated'], interface: 'datetime', readonly: true, hidden: true, width: 'half' },
      schema: { is_nullable: true },
    },
  ],
}

export const DELIVERY_STATUS_FIELD_DEFINITION = {
  field: DELIVERY_STATUS_FIELD,
  type: 'text',
  meta: {
    interface: 'input-multiline',
    readonly: true,
    width: 'full',
    note: 'Куда ушла заявка по маршруту form_routes и статус каналов (пишет forms-handler)',
  },
  schema: { is_nullable: true },
}

/**
 * Создаёт `form_routes` и поле `delivery_status` в коллекции заявок, если их нет.
 * Идемпотентно; сбой логируется и не мешает приёму заявок.
 */
export async function ensureRoutesSchema(ctx: RoutesContext, submissionsCollection: string): Promise<void> {
  const { CollectionsService, FieldsService } = ctx.services ?? {}
  if (!CollectionsService || !FieldsService) {
    console.warn('[forms-handler] routes: CollectionsService/FieldsService недоступны — схему маршрутов не создаю')
    return
  }

  let schema = await ctx.getSchema()
  if (!schema?.collections?.[ROUTES_COLLECTION]) {
    const collections = new CollectionsService({ schema, accountability: null })
    await collections.createOne(ROUTES_COLLECTION_DEFINITION)
    console.log(`[forms-handler] routes: создана коллекция ${ROUTES_COLLECTION} (доступ только администратору)`)
    schema = await ctx.getSchema()
  }

  const submissions = schema?.collections?.[submissionsCollection]
  if (submissions && !submissions.fields?.[DELIVERY_STATUS_FIELD]) {
    const fields = new FieldsService({ schema, accountability: null })
    await fields.createField(submissionsCollection, DELIVERY_STATUS_FIELD_DEFINITION)
    console.log(`[forms-handler] routes: добавлено поле ${submissionsCollection}.${DELIVERY_STATUS_FIELD}`)
  }
}

let ensurePromise: Promise<void> | null = null
let ensureFailedAt = 0
const ENSURE_RETRY_MS = 60_000

/** Один запуск на процесс; после сбоя — повтор не чаще раза в минуту. */
export function ensureRoutesSchemaOnce(ctx: RoutesContext, submissionsCollection: string): Promise<void> {
  if (ensurePromise) return ensurePromise
  if (ensureFailedAt && Date.now() - ensureFailedAt < ENSURE_RETRY_MS) return Promise.resolve()
  ensurePromise = ensureRoutesSchema(ctx, submissionsCollection).catch((err: any) => {
    ensureFailedAt = Date.now()
    ensurePromise = null
    console.error('[forms-handler] routes: не удалось создать схему маршрутов:', err?.message || err)
  })
  return ensurePromise
}

/** Только для тестов. */
export function resetRoutesSchemaState(): void {
  ensurePromise = null
  ensureFailedAt = 0
}
