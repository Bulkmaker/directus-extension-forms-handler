import { z } from 'zod'

const phoneSchema = z
  .string()
  .min(10, 'Телефон слишком короткий')
  .max(30, 'Телефон слишком длинный')
  .regex(/^[\d\s\+\-\(\)]+$/, 'Неверный формат телефона')

const deviceSchema = z.enum(['mobile', 'tablet', 'desktop']).optional()

const antispamSchema = z.object({
  _honeypot: z.string().max(0).optional(),
  _turnstile: z.string().optional(),
  _hcaptcha: z.string().optional(),
  _loadTime: z.number().optional(),
})

const baseLegacySchema = antispamSchema.extend({
  name: z.string().min(2, 'Имя слишком короткое').max(100, 'Имя слишком длинное'),
  phone: phoneSchema,
  email: z.string().email('Неверный формат email').max(255).optional().nullable(),
  agree: z.literal(true, {
    errorMap: () => ({ message: 'Необходимо согласие на обработку данных' }),
  }),
  device: deviceSchema,
})

const legacyContactSchema = baseLegacySchema.extend({
  type: z.literal('contact'),
  message: z.string().max(2000, 'Сообщение слишком длинное').optional().nullable(),
})

const legacyCalculatorSchema = baseLegacySchema.extend({
  type: z.literal('calculator'),
  message: z.string().max(3000, 'Сообщение слишком длинное').optional().nullable(),
  calculator_data: z
    .record(z.unknown())
    .optional()
    .refine(
      (obj) => !obj || JSON.stringify(obj).length < 20000,
      'Данные калькулятора слишком большие',
    ),
})

const legacySchema = z.discriminatedUnion('type', [
  legacyContactSchema,
  legacyCalculatorSchema,
])

const attachmentSchema = z
  .object({
    field: z.string().optional(),
    name: z.string().min(1),
    size: z.number().int().min(0),
    mimeType: z.string().optional(),
    status: z.enum(['uploaded', 'failed']).optional(),
    id: z.string().optional(),
    url: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough()

const MAX_FIELDS_BYTES = 20000
const MAX_FIELD_META_BYTES = 10000

const universalSchema = antispamSchema
  .extend({
    form_key: z.string().min(1).max(120).optional(),
    form_title: z.string().max(255).optional().nullable(),
    type: z.string().max(120).optional(),
    fields: z
      .record(z.unknown())
      .optional()
      .refine(
        obj => !obj || JSON.stringify(obj).length < MAX_FIELDS_BYTES,
        `Поля формы слишком большие (limit ${MAX_FIELDS_BYTES} bytes)`,
      ),
    field_meta: z
      .record(z.unknown())
      .optional()
      .refine(
        obj => !obj || JSON.stringify(obj).length < MAX_FIELD_META_BYTES,
        `field_meta слишком большой (limit ${MAX_FIELD_META_BYTES} bytes)`,
      ),
    attachments: z.array(attachmentSchema).max(30).optional(),
    name: z.string().max(100).optional().nullable(),
    phone: phoneSchema.optional().nullable(),
    email: z.string().email('Неверный формат email').max(255).optional().nullable(),
    message: z.string().max(5000).optional().nullable(),
    agree: z.boolean().optional().nullable(),
    device: deviceSchema,
    calculator_data: z
      .record(z.unknown())
      .optional()
      .refine(
        obj => !obj || JSON.stringify(obj).length < 20000,
        'Данные калькулятора слишком большие',
      ),
    source_url: z.string().max(500).optional().nullable(),
  })
  // .strip() (было .passthrough()) — не тащим неизвестные top-level ключи дальше.
  // pickFromFields читает только known top-level поля и root.fields[...],
  // поэтому неизвестные top-level ключи и так не используются → strip безопасен.
  .strip()

interface NormalizedAttachment {
  field?: string
  name: string
  size: number
  mimeType?: string
  status?: 'uploaded' | 'failed'
  id?: string
  url?: string
  reason?: string
}

export interface FormData {
  form_key: string
  form_title: string | null
  type: string
  name: string
  phone: string
  email?: string | null
  message?: string | null
  agree: true
  device?: 'mobile' | 'tablet' | 'desktop'
  fields: Record<string, unknown>
  field_meta?: Record<string, unknown>
  attachments: NormalizedAttachment[]
  calculator_data?: Record<string, unknown>
}

type LegacyFormData = z.infer<typeof legacySchema>
type UniversalFormInput = z.infer<typeof universalSchema>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getFirstString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function getFirstBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  return null
}

function pickFromFields(
  root: UniversalFormInput,
  candidates: string[],
): unknown {
  for (const candidate of candidates) {
    if (root[candidate as keyof UniversalFormInput] !== undefined) {
      return root[candidate as keyof UniversalFormInput]
    }
  }

  const fields = isPlainObject(root.fields) ? root.fields : {}
  for (const candidate of candidates) {
    if (fields[candidate] !== undefined) {
      return fields[candidate]
    }
  }

  return undefined
}

function normalizeFromUniversal(input: UniversalFormInput): {
  success: boolean
  data?: FormData
  errors?: string[]
} {
  const name = getFirstString(pickFromFields(input, ['name', 'client_name', 'full_name', 'fullname']))
  const phone = getFirstString(pickFromFields(input, ['phone', 'client_phone', 'tel', 'telephone']))
  const email = getFirstString(pickFromFields(input, ['email', 'client_email']))
  const message = getFirstString(pickFromFields(input, ['message', 'request_message', 'estimate_summary']))
  const agree = getFirstBoolean(pickFromFields(input, ['agree', 'privacy_consent', 'consent']))

  const calculatorRaw = pickFromFields(input, ['calculator_data', 'calculator_payload', 'estimate_payload'])
  const calculatorData = isPlainObject(calculatorRaw) ? calculatorRaw : undefined

  const errors: string[] = []

  if (!name || name.length < 2) {
    errors.push('name: Имя слишком короткое')
  }

  if (!phone || !phoneSchema.safeParse(phone).success) {
    errors.push('phone: Неверный формат телефона')
  }

  if (agree !== true) {
    errors.push('agree: Необходимо согласие на обработку данных')
  }

  if (errors.length > 0) {
    return { success: false, errors }
  }

  const type = input.type || (calculatorData ? 'calculator' : 'contact')
  const formKey = input.form_key || type || 'form'
  const fields = isPlainObject(input.fields) ? input.fields : {}
  const attachments = Array.isArray(input.attachments) ? input.attachments : []

  return {
    success: true,
    data: {
      form_key: formKey,
      form_title: input.form_title || null,
      type,
      name: name!,
      phone: phone!,
      email: email || null,
      message: message || null,
      agree: true,
      device: input.device,
      fields,
      field_meta: input.field_meta,
      attachments,
      calculator_data: calculatorData,
    },
  }
}

function normalizeFromLegacy(input: LegacyFormData): FormData {
  return {
    form_key: input.type,
    form_title: null,
    type: input.type,
    name: input.name,
    phone: input.phone,
    email: input.email || null,
    message: input.message || null,
    agree: true,
    device: input.device,
    fields: {
      name: input.name,
      phone: input.phone,
      email: input.email || null,
      message: input.message || null,
      agree: true,
      ...(input.type === 'calculator' && input.calculator_data ? { calculator_data: input.calculator_data } : {}),
    },
    attachments: [],
    ...(input.type === 'calculator' && input.calculator_data ? { calculator_data: input.calculator_data } : {}),
  }
}

export function validateForm(data: unknown): {
  success: boolean
  data?: FormData
  errors?: string[]
} {
  const isUniversalPayload =
    isPlainObject(data)
    && (
      'form_key' in data
      || 'fields' in data
      || 'attachments' in data
      || 'field_meta' in data
    )

  if (isUniversalPayload) {
    const parsed = universalSchema.safeParse(data)
    if (!parsed.success) {
      const errors = parsed.error.issues.map((e) => {
        const path = e.path.join('.')
        return path ? `${path}: ${e.message}` : e.message
      })
      return { success: false, errors }
    }
    return normalizeFromUniversal(parsed.data)
  }

  const legacy = legacySchema.safeParse(data)
  if (!legacy.success) {
    const errors = legacy.error.issues.map((e) => {
      const path = e.path.join('.')
      return path ? `${path}: ${e.message}` : e.message
    })
    return { success: false, errors }
  }

  return {
    success: true,
    data: normalizeFromLegacy(legacy.data),
  }
}
