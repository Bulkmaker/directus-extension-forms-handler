# directus-extension-forms-handler

Directus endpoint-расширение для приёма заявок с форм сайта: `POST /forms/submit`
(антиспам → валидация → запись в коллекцию → уведомления) и `GET /forms/health`.

Заявка сохраняется в коллекцию `lead_submissions` (или `FORMS_COLLECTION`), затем
уходит во все настроенные каналы: **Telegram, MAX, ВКонтакте, почта**. Каналы
независимы: можно включить один, несколько или все. Канал без настроек тихо
пропускается, его сбой не мешает остальным и не ломает ответ форме — заявка
к этому моменту уже сохранена.

## Каналы уведомлений

Все настройки задаются переменными окружения сервиса Directus (на Dokploy:
сервис CMS → **Environment** → Redeploy). Секреты в git не кладутся.

| Канал | Переменная | Обязательна | Значение |
|---|---|---|---|
| **Telegram** | `FORMS_TELEGRAM_ENABLED` | да | `true`, иначе канал выключен |
| | `TG_LEADS_BOT_TOKEN` | да | токен бота от @BotFather |
| | `TG_LEADS_CHAT_IDS` | да | id чатов через запятую: группа `-100…`, личка — id пользователя. Бот должен быть добавлен в группу |
| | `TELEGRAM_API_BASE` | нет | база Bot API, по умолчанию `https://api.telegram.org` |
| **MAX** | `MAX_BOT_TOKEN` | да | токен бота из business.max.ru (карточка бота → «Настройки») |
| | `MAX_CHAT_IDS` | одна из двух | id чатов или каналов через запятую (отрицательные, например `-73283938180439`). Бот должен быть участником, в канале — админом с правом публикации |
| | `MAX_USER_IDS` | одна из двух | id пользователей через запятую — сообщение в личку от бота (пользователь должен сначала сам написать боту) |
| | `MAX_API_BASE` | нет | база Bot API, по умолчанию `https://botapi.max.ru` (см. ниже) |
| **ВКонтакте** | `VK_GROUP_TOKEN` | да | ключ доступа сообщества с правом «Сообщения сообщества» |
| | `VK_ADMIN_IDS` | одна из двух | id получателей (peer_id) через запятую; каждый должен разрешить сообщения от сообщества |
| | `VK_CLIENT_IDS` | одна из двух | дополнительные получатели, тот же формат |
| **Почта** | `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_SMTP_SECURE`, `EMAIL_SMTP_USER`, `EMAIL_SMTP_PASSWORD` | да | SMTP-сервер. Порт по умолчанию 587, `EMAIL_SMTP_SECURE=true` для порта 465 |
| | `EMAIL_FROM` | нет | адрес отправителя, если он не задан в `email_settings` |
| | коллекция `email_settings` | да\* | синглтон в Directus: `enabled`, `to_emails`, `from_email`, `from_name` — получатели настраиваются в админке |
| | `FORM_EMAIL_TO` | нет\* | запасной вариант без коллекции: адрес(а) получателя; письмо уходит через встроенную почту Directus (`EMAIL_TRANSPORT=smtp` + те же `EMAIL_SMTP_*`) |
| | `CMS_DOMAIN` | нет | домен CMS для ссылки «открыть заявку» в письме |
| **Общие** | `FORMS_COLLECTION` | нет | коллекция заявок, по умолчанию `lead_submissions` |
| | `PUBLIC_FILES_URL` | нет | публичный адрес файлового хранилища (S3): без него вложения не попадают в уведомления ссылками и картинками |

\* Для почты нужен один из двух вариантов: коллекция `email_settings` или `FORM_EMAIL_TO`.

### Флаги в коллекции заявок

После отправки расширение отмечает в записи, куда ушло уведомление:
`telegram_notified`, `vk_notified`, `max_notified`, `email_notified` (boolean).
Поля `vk_notified` и `max_notified` необязательны: если их нет в схеме, флаг
просто не пишется (в лог уходит предупреждение), заявка сохраняется как обычно.

### MAX: особенности

- Сообщение уходит запросом `POST /messages?chat_id=…` или `?user_id=…` с
  `format: html` (`<b>`, `<i>`, `<a href>`), текст обрезается до 3900 символов.
  Если MAX не принял разметку (400), та же заявка повторяется простым текстом;
  при 429 — одна повторная попытка через секунду.
- Токен передаётся заголовком `Authorization: <token>` без `Bearer` и в логи не
  попадает.
- Документация MAX предписывает домен `platform-api2.max.ru`, но он подписан
  сертификатом Минцифры, которого нет в стандартных хранилищах. Поэтому по
  умолчанию используется `https://botapi.max.ru`. Если старый домен отключат:
  `MAX_API_BASE=https://platform-api2.max.ru` и корень Минцифры в
  `NODE_EXTRA_CA_CERTS`.
- Список чатов бота (`GET /chats`) MAX отключил в июне 2026, поэтому id чатов и
  пользователей указываются явно.
- Вложения передаются ссылками на файлы в хранилище, в MAX не загружаются.
- Суммы вида «1 500 000 ₽» пишутся с узким неразрывным пробелом, иначе приложение
  MAX принимает их за телефонный номер.

## Антиспам

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `ANTISPAM_HONEYPOT_ENABLED` / `ANTISPAM_HONEYPOT_FIELD` | `true` / `_honeypot` | скрытое поле-ловушка |
| `ANTISPAM_TIME_CHECK_ENABLED` / `ANTISPAM_TIME_CHECK_MIN_SECONDS` | `true` / `3` | форма не может быть отправлена быстрее |
| `ANTISPAM_RATE_LIMIT_ENABLED` / `ANTISPAM_RATE_LIMIT_MAX` / `ANTISPAM_RATE_LIMIT_WINDOW` | `true` / `5` / `60000` | лимит заявок с IP за окно (мс) |
| `ANTISPAM_TURNSTILE_ENABLED` + `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | выкл. | Cloudflare Turnstile |
| `ANTISPAM_HCAPTCHA_ENABLED` + `HCAPTCHA_SITE_KEY`, `HCAPTCHA_SECRET_KEY` | выкл. | hCaptcha |

## Сборка и релиз

`dist` собирает CI (`.github/workflows/build.yml`) при пуше в `main`; тег `vX.Y.Z`
запускает `release.yml`, который ставит тег на коммит со свежим `dist`. Сайты
подключают расширение tarball'ом по тегу:
`https://github.com/Bulkmaker/directus-extension-forms-handler/archive/refs/tags/vX.Y.Z.tar.gz`.

```bash
npm ci
npm run test:run
npm run build   # локальная проверка; dist в main коммитит CI
```
