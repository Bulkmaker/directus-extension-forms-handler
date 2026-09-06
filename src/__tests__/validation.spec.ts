import { describe, it, expect } from 'vitest'
import { validateForm } from '../validation.js'

const baseUniversal = {
  form_key: 'contact',
  name: 'Иван',
  phone: '+79991112233',
  agree: true,
}

function attachmentOf(url: unknown) {
  return { ...baseUniversal, attachments: [{ name: 'смета', size: 1, url }] }
}

describe('validateForm — url вложения', () => {
  it('оставляет нормальный http(s) URL', () => {
    const result = validateForm(attachmentOf('https://cms.example/assets/abc'))

    expect(result.success).toBe(true)
    expect(result.data!.attachments[0]!.url).toBe('https://cms.example/assets/abc')
  })

  it('выбрасывает HTML-инъекцию из url, но заявку принимает (лид не теряем)', () => {
    const result = validateForm(attachmentOf('<a href="https://evil.example/">Открыть смету</a>'))

    expect(result.success).toBe(true)
    expect(result.data!.attachments[0]!.url).toBeUndefined()
    expect(result.data!.attachments[0]!.name).toBe('смета')
  })

  it('выбрасывает не-http схемы (javascript:) и относительные пути', () => {
    expect(validateForm(attachmentOf('javascript:alert(1)')).data!.attachments[0]!.url).toBeUndefined()
    expect(validateForm(attachmentOf('/assets/abc')).data!.attachments[0]!.url).toBeUndefined()
  })

  it('выбрасывает url длиннее 500 символов', () => {
    const longUrl = `https://cms.example/assets/${'a'.repeat(500)}`
    const result = validateForm(attachmentOf(longUrl))

    expect(result.success).toBe(true)
    expect(result.data!.attachments[0]!.url).toBeUndefined()
  })

  it('не ломает валидацию обязательных полей формы', () => {
    const result = validateForm({ ...baseUniversal, name: 'И', attachments: [] })

    expect(result.success).toBe(false)
    expect(result.errors).toContain('name: Имя слишком короткое')
  })
})
