# Reels → Telegram бот (GitHub + Cloudflare Workers, бесплатно, без VPS, без терминала)

Отправляешь боту ссылку на Instagram Reels — получаешь mp4.

## Как это работает

```
Telegram ──webhook──▶ Cloudflare Worker ──POST──▶ cobalt-инстанс ──▶ прямая ссылка на mp4
                            │
                            └──sendVideo(url)──▶ Telegram сам скачивает и присылает файл
```

Worker ничего не хранит — только договаривается. Если Telegram не смог забрать файл
по ссылке (больше 20 МБ), Worker скачивает сам и загружает до 50 МБ.

Код деплоится автоматически из этого репозитория: любой коммит в `main` → новая версия воркера.

## Установка (один раз, всё в браузере)

### 1. Бот в Telegram
- `@BotFather` → `/newbot` → имя и username (оканчивается на `bot`) → скопировать токен.
- `@userinfobot` → Start → скопировать `Id`.

### 2. Подключить репозиторий к Cloudflare
1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Workers** → **Import a repository**.
2. Подключить GitHub (если ещё не подключён) и выбрать репозиторий `reels-bot`.
3. Project name: `reels-bot`. Build command оставить пустым, Deploy command — `npx wrangler deploy` (обычно подставляется сам).
4. **Save and Deploy**. Через минуту появится адрес вида `https://reels-bot.ИМЯ.workers.dev`.

### 3. Секреты
Workers & Pages → `reels-bot` → **Settings** → **Variables and Secrets** → **Add**, тип **Secret**:

| Имя | Значение |
|---|---|
| `BOT_TOKEN` | токен из BotFather |
| `ALLOWED_USER_ID` | ваш Id из userinfobot |
| `WEBHOOK_SECRET` | любая случайная строка (20–40 латинских букв/цифр), сохранить её |

Нажать **Deploy** (кнопка появится после добавления).

### 4. Включить вебхук
Открыть в браузере (подставить свой адрес и WEBHOOK_SECRET):

```
https://reels-bot.ИМЯ.workers.dev/setup?key=WEBHOOK_SECRET
```

Должно показать `"ok": true` и `"Webhook was set"`.

### 5. Проверить
Боту → `/start` → ответит подсказкой. Боту → ссылка на Reels → через несколько секунд видео.

## cobalt-инстансы

Адреса экстракторов лежат в `wrangler.toml` → `COBALT_INSTANCES` (перебираются по порядку).
Если бот отвечает «все инстансы отказали» — подобрать новые на https://cobalt.directory
(столбец Instagram ✅, без API-ключа и Turnstile) и заменить список прямо в GitHub
(карандаш → правка → Commit) — Cloudflare передеплоит сам.

## Ограничения

- Только публичные аккаунты.
- Надёжность зависит от чужих cobalt-инстансов.
- Лимит Telegram для бота — 50 МБ на файл; для Reels достаточно.

## Логи
Workers & Pages → `reels-bot` → **Logs** → **Begin log stream**, затем отправить боту ссылку.
