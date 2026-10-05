/**
 * Доставка заявки по маршруту: сначала арендатору, потом (по настройке) копия нам.
 *
 * Правила:
 * - каналы арендатора (почта, Telegram, MAX) независимы: сбой одного не мешает другим;
 * - copy_to_owner=true — копия в глобальные каналы (как без маршрута);
 * - copy_to_owner=false, но арендатору не ушло НИ ОДНО уведомление — заявка всё равно
 *   уходит нам (fallback): лид дороже настройки;
 * - результат — отчёт для записи в заявку (`_delivery` и `delivery_status`).
 *
 * Отправители передаются снаружи — модуль чистый и тестируется без сети.
 */
import type { FormRoute } from './routes.js'

export interface ChannelOutcome {
  ok: boolean
  error?: string
}

export interface ChannelReport extends ChannelOutcome {
  to: string[]
}

export type MaxTarget = { kind: 'user_id' | 'chat_id', id: string }

export interface TenantSenders {
  email: (to: string[]) => Promise<ChannelOutcome>
  telegram: (chatIds: string[]) => Promise<ChannelOutcome>
  max: (targets: MaxTarget[]) => Promise<ChannelOutcome>
}

/** Каналы владельца: имя канала → ушло ли. */
export type OwnerChannels = Record<string, boolean>

export interface DeliveryReport {
  route: { id: string | number, form_key: string, tenant_name: string }
  tenant: { email?: ChannelReport, telegram?: ChannelReport, max?: ChannelReport }
  tenant_ok: boolean
  owner: { mode: 'copy' | 'fallback' | 'off', channels: OwnerChannels }
  at: string
}

function describeTenant(route: FormRoute): string {
  return route.tenant_name ? `«${route.tenant_name}»` : `по маршруту ${route.form_key}`
}

function summarizeTenant(report: DeliveryReport['tenant']): string {
  const parts: string[] = []
  if (report.email) parts.push(`почта ${report.email.to.join(', ')} — ${report.email.ok ? 'ушло' : 'ошибка'}`)
  if (report.telegram) parts.push(`Telegram (${report.telegram.to.length}) — ${report.telegram.ok ? 'ушло' : 'ошибка'}`)
  if (report.max) parts.push(`MAX (${report.max.to.length}) — ${report.max.ok ? 'ушло' : 'ошибка'}`)
  return parts.join('; ')
}

/** Строка для копии владельцу: кому ушла заявка и почему пришла нам. */
export function buildOwnerNote(route: FormRoute, tenant: DeliveryReport['tenant'], mode: 'copy' | 'fallback'): string {
  const who = describeTenant(route)
  const summary = summarizeTenant(tenant)
  return mode === 'copy'
    ? `Копия: заявка ушла арендатору ${who} (${summary}).`
    : `Арендатору ${who} заявка НЕ доставлена (${summary}) — поэтому пришла вам.`
}

async function runChannel(
  send: () => Promise<ChannelOutcome>,
  to: string[],
): Promise<ChannelReport> {
  try {
    const outcome = await send()
    return { ok: Boolean(outcome?.ok), to, ...(outcome?.error ? { error: outcome.error.slice(0, 300) } : {}) }
  }
  catch (err: any) {
    return { ok: false, to, error: String(err?.message || err).slice(0, 300) }
  }
}

export async function deliverByRoute(
  route: FormRoute,
  senders: TenantSenders,
  notifyOwner: (note: string) => Promise<OwnerChannels>,
  now: Date = new Date(),
): Promise<DeliveryReport> {
  const maxTargets: MaxTarget[] = [
    ...route.max_chat_ids.map(id => ({ kind: 'chat_id' as const, id })),
    ...route.max_user_ids.map(id => ({ kind: 'user_id' as const, id })),
  ]

  const [email, telegram, max] = await Promise.all([
    route.emails.length > 0 ? runChannel(() => senders.email(route.emails), route.emails) : undefined,
    route.telegram_chat_ids.length > 0 ? runChannel(() => senders.telegram(route.telegram_chat_ids), route.telegram_chat_ids) : undefined,
    maxTargets.length > 0 ? runChannel(() => senders.max(maxTargets), maxTargets.map(t => `${t.kind === 'chat_id' ? 'chat' : 'user'}:${t.id}`)) : undefined,
  ])

  const tenant: DeliveryReport['tenant'] = {}
  if (email) tenant.email = email
  if (telegram) tenant.telegram = telegram
  if (max) tenant.max = max
  const tenantOk = Boolean(email?.ok || telegram?.ok || max?.ok)

  let mode: DeliveryReport['owner']['mode'] = 'off'
  if (route.copy_to_owner) mode = 'copy'
  else if (!tenantOk) mode = 'fallback'

  let channels: OwnerChannels = {}
  if (mode !== 'off') {
    try {
      channels = await notifyOwner(buildOwnerNote(route, tenant, mode))
    }
    catch (err) {
      console.error('[forms-handler] route: копия владельцу упала', err)
    }
  }

  if (!tenantOk) {
    console.error(`[forms-handler][ALERT] route ${route.form_key}: арендатору ${describeTenant(route)} не доставлено ни по одному каналу (${summarizeTenant(tenant)})`)
  }

  return {
    route: { id: route.id, form_key: route.form_key, tenant_name: route.tenant_name },
    tenant,
    tenant_ok: tenantOk,
    owner: { mode, channels },
    at: now.toISOString(),
  }
}

const CHANNEL_NAMES: Record<string, string> = {
  telegram: 'Telegram',
  vk: 'VK',
  max: 'MAX',
  email: 'почта',
}

function mark(ok: boolean): string {
  return ok ? '✓' : '✗'
}

/** Человекочитаемый статус для поля delivery_status (видно в списке заявок). */
export function formatDeliveryStatus(report: DeliveryReport): string {
  const lines: string[] = []
  lines.push(`Маршрут ${report.route.form_key}${report.route.tenant_name ? ` → ${report.route.tenant_name}` : ''}`)
  const { email, telegram, max } = report.tenant
  if (email) lines.push(`Почта ${email.to.join(', ')}: ${mark(email.ok)}${email.error ? ` ${email.error}` : ''}`)
  if (telegram) lines.push(`Telegram ${telegram.to.join(', ')}: ${mark(telegram.ok)}${telegram.error ? ` ${telegram.error}` : ''}`)
  if (max) lines.push(`MAX ${max.to.join(', ')}: ${mark(max.ok)}${max.error ? ` ${max.error}` : ''}`)

  if (report.owner.mode === 'off') {
    lines.push('Копия нам: выключена')
  }
  else {
    const channels = Object.entries(report.owner.channels)
      .map(([name, ok]) => `${CHANNEL_NAMES[name] || name} ${mark(ok)}`)
      .join(', ')
    const title = report.owner.mode === 'fallback' ? 'Нам (арендатору не доставлено)' : 'Копия нам'
    lines.push(`${title}: ${channels || 'каналы не настроены'}`)
  }
  return lines.join('\n')
}
