/**
 * Письмо о заявке (lead-email.ts): экранирование, ссылки, разница владелец/арендатор.
 */
import { describe, expect, it } from 'vitest'
import {
  buildLeadEmail,
  buildLeadSubject,
  formatMoscowTime,
  formatPhone,
  splitMessage,
  telHref,
  type LeadEmailData,
} from '../lead-email.js'

const rentLead: LeadEmailData = {
  form_key: 'rent-masterkrysha',
  form_title: 'Мастер Крыша',
  type: 'contact',
  name: 'Иван Петров',
  phone: '8 (999) 111-22-33',
  email: 'ivan@example.ru',
  message: 'Услуга: Ремонт кровли\nПротекает крыша над верандой.\nРасчёт: 120 м², металлочерепица, монтаж, 540 000 ₽\nРайон: Сергиев Посад',
  device: 'mobile',
  fields: {
    site_id: 'masterkrysha',
    region: 'Сергиев Посад',
    page: '/remont/',
    referrer: 'https://yandex.ru/',
    utm: { utm_source: 'yandex', utm_medium: 'cpc', utm_campaign: 'krovlya' },
    calc: { area: 120, material: 'металлочерепица', work: 'монтаж', total: '540 000 ₽' },
  },
}

const NOW = new Date('2026-09-30T11:05:00Z')

describe('buildLeadEmail — содержимое', () => {
  const mail = buildLeadEmail(rentLead, {
    audience: 'tenant',
    submissionId: '3f2b9c1e-1111-4222-8333-444455556666',
    sourceUrl: 'https://masterkrysha.ru/remont/?utm_source=yandex',
    now: NOW,
  })

  it('шапка: бренд из form_title и домен из адреса страницы', () => {
    expect(mail.html).toContain('Мастер Крыша')
    expect(mail.html).toContain('masterkrysha.ru')
    expect(mail.subject).toBe('Новая заявка — Мастер Крыша: Иван Петров')
  })

  it('крупно имя и телефон, кнопка «Позвонить» с tel:+7…', () => {
    expect(mail.html).toContain('Иван Петров')
    expect(mail.html).toContain('+7 999 111-22-33')
    expect(mail.html).toContain('href="tel:+79991112233"')
    expect(mail.html).toContain('Позвонить')
  })

  it('строки «Метка: значение» из сообщения — в детали, текст клиента — в «Сообщение»', () => {
    expect(mail.html).toContain('Протекает крыша над верандой.')
    expect(mail.text).toContain('- Услуга: Ремонт кровли')
    expect(mail.text).toContain('- Расчёт: 120 м², металлочерепица, монтаж, 540 000 ₽')
    // Район есть в сообщении — из fields.region второй раз не дублируется.
    expect(mail.text.match(/Район:/g)).toHaveLength(1)
    // Расчёт уже в сообщении — fields.calc не повторяется.
    expect(mail.text).not.toContain('Площадь, м²')
  })

  it('источник: страница, откуда пришёл, UTM, устройство, время МСК', () => {
    expect(mail.text).toContain('- Страница: https://masterkrysha.ru/remont/?utm_source=yandex')
    expect(mail.text).toContain('- Откуда пришёл: https://yandex.ru/')
    expect(mail.text).toContain('utm_source=yandex · utm_medium=cpc · utm_campaign=krovlya')
    expect(mail.text).toContain('- Устройство: Телефон')
    expect(mail.text).toContain('30 сентября 2026, 14:05 (МСК)')
    expect(mail.text).not.toContain('site_id')
  })

  it('письмо арендатору — без ссылки на CMS и служебной строки маршрута', () => {
    const tenant = buildLeadEmail(rentLead, {
      audience: 'tenant',
      cmsItemUrl: 'https://api.render-room.ru/admin/content/form_submissions/1',
      routeNote: 'Копия: заявка ушла арендатору',
      now: NOW,
    })
    expect(tenant.html).not.toContain('api.render-room.ru')
    expect(tenant.html).not.toContain('Directus')
    expect(tenant.html).not.toContain('Копия: заявка ушла')
    expect(tenant.text).not.toContain('Directus')
  })

  it('письмо владельцу — со ссылкой на заявку и строкой маршрута', () => {
    const owner = buildLeadEmail(rentLead, {
      audience: 'owner',
      cmsItemUrl: 'https://api.render-room.ru/admin/content/form_submissions/1',
      routeNote: 'Копия: заявка ушла арендатору «ИП Кровлин»',
      now: NOW,
    })
    expect(owner.html).toContain('href="https://api.render-room.ru/admin/content/form_submissions/1"')
    expect(owner.html).toContain('Открыть заявку в Directus')
    expect(owner.html).toContain('Копия: заявка ушла арендатору «ИП Кровлин»')
    expect(owner.text).toContain('Открыть в Directus: https://api.render-room.ru/admin/content/form_submissions/1')
  })

  it('HTML-вёрстка под почтовые клиенты: таблицы, 600px, без внешних картинок и шрифтов', () => {
    expect(mail.html).toContain('width="600"')
    expect(mail.html).toContain('max-width:600px')
    expect(mail.html).toContain('<!--[if mso]>')
    expect(mail.html).not.toMatch(/<img[^>]+src="https?:/)
    expect(mail.html).not.toMatch(/<link\b/)
    expect(mail.html).not.toMatch(/@import|fonts\.googleapis/)
  })

  it('калькулятор проектов домов (calculator_data) попадает в детали', () => {
    const house = buildLeadEmail({
      ...rentLead,
      message: null,
      form_title: null,
      calculator_data: {
        project: { article: 'Д-120', size: '8×10' },
        selection: { timber: { label: 'Брус 150' }, foundation: { label: 'Ленточный' }, roof: { label: 'Металлочерепица' } },
        total: { value: 2500000 },
      },
    }, { audience: 'owner', fallbackTitle: 'Расчет проекта', now: NOW })
    expect(house.text).toContain('- Проект: Проект Д-120 (8×10)')
    expect(house.text).toContain('- Материал стен: Брус 150')
    expect(house.text).toMatch(/- Итого: 2\s500\s000 ₽/)
    expect(house.subject).toBe('Новая заявка — Расчет проекта: Иван Петров')
  })
})

describe('buildLeadEmail — экранирование', () => {
  const evil: LeadEmailData = {
    form_key: 'rent-x',
    form_title: '<script>alert(1)</script>"Бренд"',
    name: '<img src=x onerror=alert(1)>',
    phone: '+7 999 111-22-33',
    email: 'a"onmouseover="x@evil.ru',
    message: '<a href="https://phish.example">Жми</a>\nКомментарий: <b>жирный</b>',
    fields: { region: '"><svg onload=alert(1)>', utm: { utm_source: '<i>x</i>' } },
  }
  const mail = buildLeadEmail(evil, {
    audience: 'owner',
    sourceUrl: 'javascript:alert(1)',
    cmsItemUrl: 'javascript:alert(2)',
    now: NOW,
  })

  it('пользовательский ввод не становится разметкой', () => {
    expect(mail.html).not.toContain('<script>')
    expect(mail.html).not.toContain('<img src=x')
    expect(mail.html).not.toContain('<svg')
    expect(mail.html).not.toContain('<a href="https://phish.example"')
    expect(mail.html).not.toContain('<b>жирный</b>')
    expect(mail.html).not.toContain('<i>x</i>')
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;Бренд&quot;')
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('кривой email клиента не превращается в mailto-ссылку', () => {
    expect(mail.html).not.toContain('mailto:')
    expect(mail.html).not.toContain('onmouseover=')
  })

  it('ссылки только http(s): javascript: не попадает в href', () => {
    expect(mail.html).not.toMatch(/href="javascript:/i)
    expect(mail.html).not.toContain('Открыть заявку в Directus')
  })

  it('тема письма без CR/LF (header injection)', () => {
    const subject = buildLeadSubject({ ...evil, name: 'Иван\r\nBcc: victim@example.com', form_title: 'Сайт\n\tX' })
    expect(subject).not.toMatch(/[\r\n\t]/)
    expect(subject).toBe('Новая заявка — Сайт X: Иван Bcc: victim@example.com')
  })
})

describe('помощники', () => {
  it('telHref приводит российские номера к +7', () => {
    expect(telHref('8 (999) 111-22-33')).toBe('tel:+79991112233')
    expect(telHref('+7 999 111 22 33')).toBe('tel:+79991112233')
    expect(telHref('9991112233')).toBe('tel:+79991112233')
    expect(telHref('+381 64 123 4567')).toBe('tel:+381641234567')
    expect(telHref('12')).toBeNull()
  })

  it('formatPhone', () => {
    expect(formatPhone('89991112233')).toBe('+7 999 111-22-33')
    expect(formatPhone('+381 64 123 4567')).toBe('+381 64 123 4567')
  })

  it('formatMoscowTime — UTC+3', () => {
    expect(formatMoscowTime(new Date('2026-12-31T22:30:00Z'))).toBe('1 января 2027, 01:30 (МСК)')
  })

  it('splitMessage не принимает «https://…» за метку', () => {
    const { rows, text } = splitMessage('https://example.ru/page\nУслуга: Кровля')
    expect(rows).toEqual([{ label: 'Услуга', value: 'Кровля' }])
    expect(text).toBe('https://example.ru/page')
  })
})
