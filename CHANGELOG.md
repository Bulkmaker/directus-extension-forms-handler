# Changelog — directus-extension-forms-handler

Формат [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии по [SemVer](https://semver.org/lang/ru/).

> **Легенда «Безопасно обновлять»:** ✅ да (обратно совместимо) · ⚠️ с проверкой (протестировать на dev) · ❌ breaking (читать перед обновлением).

## [1.1.0] — 2026-09-18
### Added
- SOCKS5-прокси к Telegram API (`TG_SOCKS_HOST`/`TG_SOCKS_PORT`/`TG_SOCKS_USER`/`TG_SOCKS_PASS`) —
  для хостов, где `api.telegram.org` недоступен напрямую (напр. VPS в РФ). Пусто = прежнее
  прямое подключение, поведение не меняется. Тот же пакет (`socks-proxy-agent`) и приём,
  что и в telegram-bot-dokploy (rr-infra), только через `node:https`/`node:http` вместо
  telegraf-клиента.

**Безопасно обновлять:** ✅ да (новая переменная опциональна, дефолт — старое поведение).

## [1.0.0] — 2026-07-09
### Changed
- Первый релиз: обработчик форм (антиспам, Telegram/VK/email)
- Сборка `dist` — в GitHub Actions (при пуше в `src`), `dist` коммитится в `main`.

**Безопасно обновлять:** ✅ да.

---
_Правила: при релизе добавляй `## [версия] — дата` (Added/Changed/Fixed/Removed) + строку **Безопасно обновлять**, ставь тег `v<версия>`._
