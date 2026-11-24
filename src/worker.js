/**
 * Instagram Reels → Telegram bot на Cloudflare Workers.
 *
 * Поток: Telegram webhook → Worker → поиск прямой ссылки на mp4 (см. resolveMedia)
 *        → Telegram sendVideo(url).
 * Если Telegram не смог забрать файл по ссылке (>20 МБ, 403 и т.п.),
 * Worker скачивает файл сам и загружает его как multipart (до 50 МБ).
 *
 * Секреты (Cloudflare → Settings → Variables and Secrets):
 *   BOT_TOKEN, WEBHOOK_SECRET — обязательные
 *   ALLOWED_USER_ID — необязательный: если задан, бот отвечает только этому Telegram ID
 *   OWNER_ID        — Telegram ID владельца: /stats, недельная сводка, подробные ошибки,
 *                     уведомления о чужих скачиваниях
 * Переменные (wrangler.toml [vars]): COBALT_INSTANCES, INSTAFIX_HOSTS, STATS_UTC_OFFSET
 * Привязка KV (wrangler.toml [[kv_namespaces]]): USERS — статистика пользователей
 * Расписание (wrangler.toml [triggers]): недельная сводка владельцу
 */

const INSTAGRAM_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:[\w.]+\/)?(?:reels?|p|tv|share)\/[\w-]+\/?[^\s]*/i;

const TG_URL_LIMIT = 20 * 1024 * 1024; // sendVideo по URL
const TG_UPLOAD_LIMIT = 50 * 1024 * 1024; // sendVideo multipart
const COBALT_TIMEOUT_MS = 12_000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Одноразовая настройка вебхука без терминала:
    // открыть в браузере https://<worker>.workers.dev/setup?key=<WEBHOOK_SECRET>
    if (request.method === 'GET' && url.pathname === '/setup') {
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const result = await tg(
        env,
        'setWebhook',
        {
          url: `${url.origin}/`,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ['message'],
        },
        { throwOnError: false },
      );
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method !== 'POST') {
      return new Response('reels-bot: ok');
    }
    // Проверяем, что апдейт действительно от Telegram
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('bad json', { status: 400 });
    }

    // Отвечаем Telegram сразу, работу делаем в фоне — иначе Telegram будет ретраить
    ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error('unhandled', e)));
    return new Response('ok');
  },

  // Cron Trigger из wrangler.toml: недельная сводка владельцу
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendWeeklyDigest(env).catch((e) => console.error('digest failed', e)));
  },
};

async function handleUpdate(update, env) {
  const msg = update.message ?? update.channel_post;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const fromId = String(msg.from?.id ?? msg.chat.id);

  if (env.ALLOWED_USER_ID && fromId !== String(env.ALLOWED_USER_ID)) {
    return; // чужих молча игнорируем
  }

  const isOwner = Boolean(env.OWNER_ID) && fromId === String(env.OWNER_ID);
  if (isOwner && /^\/stats(?:@\w+)?(?:\s|$)/.test(msg.text)) {
    const arg = msg.text.trim().split(/\s+/)[1] || '';
    await tg(env, 'sendMessage', { chat_id: chatId, text: await buildStats(env, arg) });
    return;
  }

  if (msg.text.startsWith('/start')) {
    await track(env, msg.from, 'seen');
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Пришли ссылку на Reels — верну видеофайл.',
    });
    return;
  }

  const match = msg.text.match(INSTAGRAM_RE);
  if (!match) {
    await track(env, msg.from, 'seen');
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'Нужна ссылка на Instagram Reels.' });
    return;
  }

  const url = cleanInstagramUrl(match[0]);
  await tg(env, 'sendChatAction', { chat_id: chatId, action: 'upload_video' });

  let ok = false;
  try {
    const media = await resolveMedia(url, env);
    await deliverVideo(env, chatId, media);
    ok = true;
  } catch (e) {
    console.error('failed', url, e);
    // Технические подробности — только владельцу (или всем, пока OWNER_ID не задан)
    const detailed = isOwner || !env.OWNER_ID;
    await tg(
      env,
      'sendMessage',
      {
        chat_id: chatId,
        text: detailed
          ? `Не получилось: ${e.message ?? e}`
          : 'Не получилось скачать этот ролик. Попробуйте позже или пришлите другую ссылку.',
      },
      { throwOnError: false },
    );
  } finally {
    await track(env, msg.from, ok ? 'ok' : 'fail');
    if (!isOwner) await notifyOwner(env, msg.from, url, ok);
  }
}

/** Владельцу — сообщение о каждом чужом скачивании: кто и какую ссылку прислал. */
async function notifyOwner(env, from, url, ok) {
  if (!env.OWNER_ID || !from?.id) return;
  const who = userLabel({
    id: from.id,
    username: from.username,
    name: [from.first_name, from.last_name].filter(Boolean).join(' '),
  });
  try {
    await tg(
      env,
      'sendMessage',
      {
        chat_id: String(env.OWNER_ID),
        text: `${ok ? '⬇️' : '⚠️'} ${who} ${ok ? 'скачал' : 'не смог скачать'}:\n${url}`,
        link_preview_options: { is_disabled: true },
      },
      { throwOnError: false },
    );
  } catch (e) {
    console.warn('notifyOwner failed', e);
  }
}

/* ------------------------------------------------------------------ *
 * Статистика. KV USERS, ключ user:<telegram id>. В записи:
 *   first/last — первое и последнее обращение; req/ok — запросов на скачивание всего / успешных;
 *   days — счётчики по дням за последние STATS_KEEP_DAYS суток: { <номер дня>: [запросов, успешных] }.
 * Копия записи кладётся в metadata ключа: тогда /stats читает всех одним list(),
 * без отдельного чтения на каждого пользователя (лимит подзапросов на бесплатном тарифе).
 * На каждую присланную ссылку — одна запись в KV.
 * ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;
const STATS_KEEP_DAYS = 15;
const STATS_TOP = 30;
const LEGACY_READ_LIMIT = 30;

/** Сдвиг от UTC в часах для границ суток. По умолчанию Москва (+3). */
function tzOffsetMs(env) {
  const h = Number(env.STATS_UTC_OFFSET ?? 3);
  return (Number.isFinite(h) ? h : 3) * 60 * 60 * 1000;
}

function dayIndex(ts, env) {
  return Math.floor((ts + tzOffsetMs(env)) / DAY_MS);
}

function fmtDay(idx) {
  const d = new Date(idx * DAY_MS);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Учёт не должен ломать основную работу: любые ошибки KV только в лог. */
async function track(env, from, event) {
  if (!env.USERS || !from?.id) return;
  try {
    await trackUser(env, from, event);
  } catch (e) {
    console.warn('trackUser failed', e);
  }
}

/** event: 'seen' — просто написал боту; 'ok' / 'fail' — прислал ссылку, результат скачивания. */
async function trackUser(env, from, event) {
  const kv = env.USERS;
  const key = `user:${from.id}`;
  const now = Date.now();
  const prev = await kv.get(key, 'json');

  // «Просто написал» — не чаще раза в час, чтобы не тратить лимит записей KV
  if (event === 'seen' && prev && now - prev.last < 60 * 60 * 1000) return;

  const today = dayIndex(now, env);
  const days = {};
  for (const [d, v] of Object.entries(prev?.days ?? {})) {
    if (Number(d) > today - STATS_KEEP_DAYS && Array.isArray(v)) days[d] = v;
  }
  const isReq = event === 'ok' || event === 'fail';
  if (isReq) {
    const cur = days[today] ?? [0, 0];
    days[today] = [cur[0] + 1, cur[1] + (event === 'ok' ? 1 : 0)];
  }

  const rec = {
    ...(prev ?? {}),
    id: from.id,
    first: prev?.first ?? now,
    last: now,
    username: from.username ?? null,
    name: [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 64),
    req: (prev?.req ?? 0) + (isReq ? 1 : 0),
    ok: (prev?.ok ?? 0) + (event === 'ok' ? 1 : 0),
    days,
  };

  // metadata ограничена 1024 байтами
  let metadata = rec;
  if (new TextEncoder().encode(JSON.stringify(metadata)).length > 1000) metadata = { ...rec, name: '' };
  if (new TextEncoder().encode(JSON.stringify(metadata)).length > 1000) metadata = undefined;

  await kv.put(key, JSON.stringify(rec), metadata ? { metadata } : undefined);
}

async function loadUsers(kv) {
  const users = [];
  let skipped = 0;
  let legacyReads = 0;
  let cursor;
  do {
    const page = await kv.list({ prefix: 'user:', cursor });
    for (const k of page.keys) {
      let u = k.metadata;
      if (!u) {
        // Записи старого формата (без metadata) дочитываем по одной, но не больше лимита
        if (legacyReads >= LEGACY_READ_LIMIT) {
          skipped++;
          continue;
        }
        legacyReads++;
        u = await kv.get(k.name, 'json');
        if (!u) continue;
      }
      users.push({ ...u, id: u.id ?? k.name.slice('user:'.length) });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return { users, skipped };
}

function userLabel(u) {
  if (u.username) return `@${u.username}`;
  return `${u.name || 'без имени'} (id ${u.id})`;
}

/**
 * /stats        — последние 7 дней, включая сегодня
 * /stats week   — 7 полных дней до сегодня (то же, что приходит в недельной сводке)
 * /stats all    — за всё время
 */
async function buildStats(env, arg = '') {
  if (!env.USERS) return 'KV-хранилище USERS не подключено — статистика не ведётся.';
  const { users, skipped } = await loadUsers(env.USERS);
  const today = dayIndex(Date.now(), env);
  const mode = arg.toLowerCase();

  let text;
  if (mode === 'all') text = reportAllTime(users);
  else if (mode === 'week') text = reportPeriod(env, users, today - 7, today - 1, 'Сводка за неделю');
  else text = reportPeriod(env, users, today - 6, today, 'Статистика за 7 дней');

  if (skipped) text += `\n\nНе показано старых записей: ${skipped} (появятся после следующего обращения этих пользователей).`;
  if (mode !== 'all' && mode !== 'week') text += '\n\n/stats week — прошлые 7 полных дней\n/stats all — за всё время';
  return text;
}

function reportPeriod(env, users, fromDay, toDay, title) {
  const rows = [];
  let req = 0;
  let ok = 0;
  let newcomers = 0;
  for (const u of users) {
    let r = 0;
    let o = 0;
    for (const [d, v] of Object.entries(u.days ?? {})) {
      const n = Number(d);
      if (n >= fromDay && n <= toDay && Array.isArray(v)) {
        r += v[0] || 0;
        o += v[1] || 0;
      }
    }
    if (u.first) {
      const fd = dayIndex(u.first, env);
      if (fd >= fromDay && fd <= toDay) newcomers++;
    }
    if (r > 0) rows.push({ u, r, o });
    req += r;
    ok += o;
  }
  rows.sort((a, b) => b.r - a.r || (b.u.last ?? 0) - (a.u.last ?? 0));

  const lines = rows.slice(0, STATS_TOP).map(({ u, r, o }, i) => {
    const fails = r - o;
    return `${i + 1}. ${userLabel(u)} — ${r}${fails ? ` (не скачалось: ${fails})` : ''}`;
  });
  if (rows.length > STATS_TOP) lines.push(`… и ещё пользователей: ${rows.length - STATS_TOP}`);

  const head = `📊 ${title} (${fmtDay(fromDay)}–${fmtDay(toDay)})`;
  if (!rows.length) {
    return `${head}\n\nЗапросов на скачивание не было.${newcomers ? `\nНовых пользователей: ${newcomers}` : ''}\nВсего пользователей за всё время: ${users.length}`;
  }
  return [
    head,
    '',
    `Скачивали: ${rows.length} чел.`,
    `Запросов: ${req}, из них успешно: ${ok}`,
    `Новых пользователей: ${newcomers}`,
    '',
    'Кто сколько раз:',
    ...lines,
    '',
    `Всего пользователей за всё время: ${users.length}`,
  ].join('\n');
}

function reportAllTime(users) {
  const rows = users.filter((u) => (u.req ?? 0) > 0).sort((a, b) => b.req - a.req);
  const req = rows.reduce((n, u) => n + u.req, 0);
  const ok = rows.reduce((n, u) => n + (u.ok ?? 0), 0);
  const lines = rows.slice(0, STATS_TOP).map((u, i) => {
    const fails = u.req - (u.ok ?? 0);
    return `${i + 1}. ${userLabel(u)} — ${u.req}${fails ? ` (не скачалось: ${fails})` : ''}`;
  });
  if (rows.length > STATS_TOP) lines.push(`… и ещё пользователей: ${rows.length - STATS_TOP}`);
  return [
    '📊 Статистика за всё время',
    '',
    `Всего пользователей: ${users.length}`,
    `Запросов: ${req}, из них успешно: ${ok}`,
    ...(lines.length ? ['', 'Кто сколько раз:', ...lines] : []),
  ].join('\n');
}

/** Раз в неделю по расписанию: сводка за 7 полных дней — только владельцу. */
async function sendWeeklyDigest(env) {
  if (!env.OWNER_ID || !env.USERS) {
    console.warn('digest skipped: нужны OWNER_ID и привязка USERS');
    return;
  }
  await tg(env, 'sendMessage', { chat_id: String(env.OWNER_ID), text: await buildStats(env, 'week') });
}

/** Убираем трекинг-параметры (?igsh=..., utm) — cobalt они не нужны. */
function cleanInstagramUrl(raw) {
  const u = new URL(raw);
  u.search = '';
  u.hash = '';
  return u.toString();
}

/**
 * Цепочка способов достать mp4. Первый успешный — победил.
 *   1. ig-web    — анонимная веб-сессия Instagram + GraphQL (как браузер без логина)
 *   2. ig-page   — HTML страницы ролика
 *   3. ig-embed  — embed-страница
 *   4. instafix  — зеркала InstaFix из INSTAFIX_HOSTS
 *   5. cobalt    — внешние инстансы из COBALT_INSTANCES
 * @returns {Promise<{url: string, filename?: string, width?: number, height?: number}>}
 */
async function resolveMedia(url, env) {
  const shortcode = extractShortcode(url) || (await resolveShareLink(url));
  const errors = [];

  if (shortcode) {
    const instafixHosts = (env.INSTAFIX_HOSTS || 'www.ddinstagram.com,www.kkinstagram.com')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);

    for (const [name, fn] of [
      ['ig-web', igWeb],
      ['ig-page', igPage],
      ['ig-embed', igEmbed],
      ...instafixHosts.map((h) => [`instafix:${h.replace(/^www\./, '')}`, (code) => instafix(h, code)]),
    ]) {
      try {
        const media = await fn(shortcode);
        if (media) return media;
        errors.push(`${name}: пусто`);
      } catch (e) {
        errors.push(`${name}: ${e.message}`);
      }
    }
  } else {
    errors.push('shortcode не распознан');
  }

  try {
    return await resolveViaCobalt(url, env);
  } catch (e) {
    errors.push(e.message);
  }
  throw new Error(errors.join('; '));
}

/** /reel/ABC/, /reels/ABC/, /p/ABC/, /tv/ABC/ → ABC */
function extractShortcode(url) {
  const m = url.match(/instagram\.com\/(?:[\w.]+\/)?(?:reels?|p|tv)\/([\w-]+)/i);
  return m ? m[1] : null;
}

/** Ссылки вида /share/reel/XXXX — это редирект на настоящий /reel/CODE/ */
async function resolveShareLink(url) {
  if (!/instagram\.com\/share\//i.test(url)) return null;
  try {
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA } });
    const loc = res.headers.get('location') || '';
    return extractShortcode(loc);
  } catch {
    return null;
  }
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ *
 * Способ 1: «как браузер без логина».
 *
 * Сайт Instagram для незалогиненного посетителя делает три шага, и мы их повторяем:
 *   1) открывает главную страницу — получает стартовые cookies и токен LSD;
 *   2) спрашивает /api/v1/web/get_ruling_for_content/ — доступна ли публикация
 *      (заодно Instagram выставляет cookie csrftoken);
 *   3) запрашивает данные публикации через /api/graphql.
 * Этот путь не зависит от embed-страницы, поэтому подходит и для совместных
 * публикаций (collab), у которых embed отдаёт только обложку.
 *
 * Запросов шага 3 два — их используют актуальные yt-dlp и instaloader (ноябрь 2026).
 * doc_id меняются Instagram раз в несколько месяцев: если оба запроса начнут
 * отвечать «нет данных», первым делом сверить doc_id с этими проектами.
 * ------------------------------------------------------------------ */

const IG_APP_ID = '936619743392459';
const IG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const IG_SESSION_TTL_MS = 10 * 60 * 1000;

/** Анонимная сессия живёт в памяти экземпляра Worker — экономит запросы к Instagram. */
let igSessionCache = null;

/** Шорткод → числовой id публикации (media_id). */
function shortcodeToMediaId(shortcode) {
  // У закрытых публикаций к шорткоду приклеено 28 лишних символов
  const code = shortcode.length > 28 ? shortcode.slice(0, -28) : shortcode;
  let n = 0n;
  for (const ch of code) {
    const i = IG_ALPHABET.indexOf(ch);
    if (i < 0) return null;
    n = n * 64n + BigInt(i);
  }
  return n.toString();
}

function absorbCookies(jar, res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of list) {
    const pair = line.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!value || value === '""' || value === 'deleted') jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function igSession() {
  if (igSessionCache && Date.now() - igSessionCache.at < IG_SESSION_TTL_MS) return igSessionCache;

  const res = await fetch('https://www.instagram.com/', {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`главная HTTP ${res.status}`);
  const html = await res.text();
  const jar = new Map();
  absorbCookies(jar, res);

  let lsd = null;
  const eqmc = html.match(/<script\b[^>]*\bid="__eqmc"[^>]*>([^<]+)<\/script>/);
  if (eqmc) {
    try {
      const l = JSON.parse(eqmc[1]).l;
      if (typeof l === 'string' && l) lsd = l;
    } catch {}
  }
  if (!lsd) lsd = html.match(/"LSD",\[\],\{[^{}]*"token":"([^"]+)"/)?.[1] ?? null;
  if (!lsd) {
    throw new Error(/\/accounts\/login/.test(res.url) ? 'главная ведёт на логин' : 'на главной нет токена LSD');
  }
  if (!jar.has('csrftoken')) {
    const csrf = html.match(/"csrf_token":"([^"]+)"/)?.[1];
    if (csrf) jar.set('csrftoken', csrf);
  }

  igSessionCache = { at: Date.now(), jar, lsd };
  return igSessionCache;
}

function igApiHeaders(session, referer) {
  const csrf = session.jar.get('csrftoken');
  return {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-IG-App-ID': IG_APP_ID,
    'X-ASBD-ID': '359341',
    'X-IG-WWW-Claim': '0',
    'X-Requested-With': 'XMLHttpRequest',
    ...(csrf ? { 'X-CSRFToken': csrf } : {}),
    Origin: 'https://www.instagram.com',
    Referer: referer,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    ...(session.jar.size ? { Cookie: cookieHeader(session.jar) } : {}),
  };
}

async function igWeb(shortcode) {
  const mediaId = shortcodeToMediaId(shortcode);
  if (!mediaId) throw new Error('не удалось вычислить media_id');

  let session;
  try {
    session = await igSession();
  } catch (e) {
    igSessionCache = null;
    throw e;
  }
  const referer = `https://www.instagram.com/reel/${shortcode}/`;

  // Шаг 2: проверка доступности. Ошибка здесь не фатальна — пробуем дальше.
  let ruling = '';
  try {
    const res = await fetch(
      `https://www.instagram.com/api/v1/web/get_ruling_for_content/?content_type=MEDIA&target_id=${mediaId}`,
      { headers: igApiHeaders(session, referer) },
    );
    absorbCookies(session.jar, res);
    const json = await res.json().catch(() => null);
    if (json && json.status !== 'ok') {
      ruling = [json.title, json.description].filter(Boolean).join(': ');
    }
  } catch {}

  const queries = [
    {
      name: 'PolarisLoggedOutDesktopWWWPostRootContentQuery',
      doc_id: '27130156389949648',
      variables: { media_id: mediaId },
      extract: (data) => {
        const m = data?.xig_polaris_media;
        return m?.if_not_gated_logged_out ?? (m?.video_versions || m?.carousel_media ? m : null);
      },
    },
    {
      name: 'PolarisPostRootQuery',
      doc_id: '27128499623469141',
      variables: {
        shortcode,
        __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
      },
      extract: (data) => data?.xdt_api__v1__media__shortcode__web_info?.items?.[0] ?? null,
    },
  ];

  const errors = [];
  for (const [i, q] of queries.entries()) {
    try {
      const res = await fetch('https://www.instagram.com/api/graphql', {
        method: 'POST',
        headers: {
          ...igApiHeaders(session, referer),
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-FB-LSD': session.lsd,
          'X-FB-Friendly-Name': q.name,
        },
        body: new URLSearchParams({
          av: '0',
          lsd: session.lsd,
          fb_api_caller_class: 'RelayModern',
          fb_api_req_friendly_name: q.name,
          server_timestamps: 'true',
          variables: JSON.stringify(q.variables),
          doc_id: q.doc_id,
        }),
      });
      absorbCookies(session.jar, res);
      if (!res.ok) {
        // Сессию могли забраковать — в следующий раз начнём с чистой
        if ([401, 403, 429].includes(res.status)) igSessionCache = null;
        throw new Error(`HTTP ${res.status}`);
      }
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text.replace(/^for\s*\(;;\);/, ''));
      } catch {
        throw new Error('ответ не JSON (страница логина?)');
      }
      const item = q.extract(json?.data);
      if (!item) {
        throw new Error(json?.errors?.[0]?.message ? `ошибка Instagram: ${json.errors[0].message}` : 'нет данных');
      }
      const media = pickFromProduct(item, shortcode);
      if (media) return media;
      throw new Error('в посте нет видео');
    } catch (e) {
      errors.push(`запрос ${i + 1}: ${e.message}`);
    }
  }
  if (ruling) errors.push(`Instagram: ${ruling}`);
  throw new Error(errors.join(' / '));
}

/** Ответ в «мобильном» формате: video_versions у самой публикации или у элементов карусели. */
function pickFromProduct(item, shortcode) {
  for (const node of [item, ...(Array.isArray(item.carousel_media) ? item.carousel_media : [])]) {
    const versions = (node?.video_versions || []).filter((v) => v?.url);
    if (!versions.length) continue;
    const best = versions.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
    return {
      url: best.url,
      filename: `${shortcode}.mp4`,
      width: best.width || node.original_width || undefined,
      height: best.height || node.original_height || undefined,
    };
  }
  return null;
}

/**
 * Способ 1б: HTML самой страницы ролика. Instagram вшивает в неё JSON с video_versions
 * (так видео получает обычный браузер без логина).
 */
async function igPage(shortcode) {
  const res = await fetch(`https://www.instagram.com/reel/${shortcode}/`, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (/\/accounts\/login/.test(res.url)) throw new Error('редирект на логин');

  // video_versions: [{"width":720,"height":1280,"url":"https:\/\/..."}]
  const m = html.match(/"video_versions":\s*(\[[^\]]*\])/);
  if (m) {
    try {
      const arr = JSON.parse(m[1]);
      const best = arr.filter((v) => v.url).sort((a, b) => (b.width || 0) - (a.width || 0))[0];
      if (best) return { url: best.url, filename: `${shortcode}.mp4`, width: best.width, height: best.height };
    } catch {}
  }
  const m2 = html.match(/"video_url":"([^"]+)"/);
  if (m2) return { url: JSON.parse(`"${m2[1]}"`), filename: `${shortcode}.mp4` };
  throw new Error(/login/i.test(html.slice(0, 2000)) ? 'страница требует логин' : 'video_versions не найден');
}

/**
 * Способ 2б: InstaFix (ddinstagram / kkinstagram) — открытый сервис, который сам ходит в Instagram
 * и отдаёт прямую ссылку в og:video. OG-теги он показывает только «ботам», поэтому UA — как у Telegram.
 */
async function instafix(host, shortcode) {
  const res = await fetch(`https://${host}/reel/${shortcode}/`, {
    headers: {
      'User-Agent': 'TelegramBot (like TwitterBot)',
      Accept: 'text/html',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const og = (prop) => {
    const m =
      html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i'));
    return m ? m[1].replace(/&amp;/g, '&') : null;
  };

  let videoUrl = og('og:video') || og('og:video:url') || og('og:video:secure_url');
  if (!videoUrl) throw new Error('нет og:video (отдал только превью)');
  if (videoUrl.startsWith('/')) videoUrl = `https://${host}${videoUrl}`;

  // Проверяем, что по ссылке действительно видео, а не постер
  const head = await fetch(videoUrl, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': UA } }).catch(() => null);
  const ctype = head?.headers.get('content-type') || '';
  if (head && head.ok && /^image\//i.test(ctype)) throw new Error('по ссылке картинка, не видео');

  const w = Number(og('og:video:width')) || undefined;
  const h = Number(og('og:video:height')) || undefined;
  return { url: head?.url || videoUrl, filename: `${shortcode}.mp4`, width: w, height: h };
}

/** Способ 2: embed-страница, в её HTML зашит video_url. */
async function igEmbed(shortcode) {
  const res = await fetch(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const m = html.match(/"video_url":"([^"]+)"/);
  if (!m) throw new Error('video_url не найден');
  // В HTML слэши экранированы: https:\/\/..., и & вместо &
  const videoUrl = JSON.parse(`"${m[1]}"`);
  const dim = html.match(/"dimensions":\{"height":(\d+),"width":(\d+)\}/);
  return {
    url: videoUrl,
    filename: `${shortcode}.mp4`,
    height: dim ? Number(dim[1]) : undefined,
    width: dim ? Number(dim[2]) : undefined,
  };
}

/**
 * Если размеры неизвестны — читаем начало mp4 и достаём их из заголовка (tkhd).
 * Без этого Telegram иногда считает видео квадратным и сжимает картинку.
 */
async function probeDimensions(url) {
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-2097151', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const dv = new DataView(buf.buffer);

    // Ищем сигнатуру 'tkhd' и читаем ширину/высоту (fixed 16.16)
    for (let i = 4; i + 92 < buf.length; i++) {
      if (buf[i] === 0x74 && buf[i + 1] === 0x6b && buf[i + 2] === 0x68 && buf[i + 3] === 0x64) {
        const version = buf[i + 4];
        const off = i + 4 + (version === 1 ? 88 : 76);
        const width = dv.getUint32(off) >>> 16;
        const height = dv.getUint32(off + 4) >>> 16;
        if (width > 0 && height > 0 && width < 10000 && height < 10000) {
          return { width, height };
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Способ 3: перебираем cobalt-инстансы по очереди.
 */
async function resolveViaCobalt(url, env) {
  const instances = (env.COBALT_INSTANCES || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  if (!instances.length) throw new Error('COBALT_INSTANCES не задан');

  const errors = [];
  for (const base of instances) {
    try {
      const media = await askCobalt(base, url);
      if (media) return media;
    } catch (e) {
      errors.push(`${new URL(base).host}: ${e.message}`);
    }
  }
  throw new Error('все инстансы отказали — ' + errors.join('; '));
}

async function askCobalt(base, url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), COBALT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(base + '/', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'reels-tg-bot/1.0 (personal use)',
      },
      body: JSON.stringify({
        url,
        videoQuality: '1080',
        filenameStyle: 'basic',
        downloadMode: 'auto',
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}, не JSON`);
  }

  switch (data.status) {
    case 'tunnel':
    case 'redirect':
      // cobalt иногда отдаёт обложку (.jpg) вместо видео — это не результат, идём дальше
      if (/\.(jpe?g|png|webp|heic)(\?|$)/i.test(data.filename || '')) {
        throw new Error('отдал картинку вместо видео');
      }
      return { url: data.url, filename: data.filename };

    case 'picker': {
      // Карусель: берём первое видео
      const video = (data.picker || []).find((p) => p.type === 'video');
      if (!video) throw new Error('в посте нет видео');
      return { url: video.url, filename: data.filename };
    }

    case 'local-processing': {
      // Инстанс просит клиента склеивать дорожки сам — Worker этого не умеет
      const single = data.tunnel?.length === 1 ? data.tunnel[0] : null;
      if (single) return { url: single, filename: data.output?.filename };
      throw new Error('инстанс требует локальной обработки');
    }

    case 'error':
      throw new Error(data.error?.code ?? 'error');

    default:
      throw new Error(`неизвестный статус ${data.status}`);
  }
}

/**
 * Сначала пробуем самый быстрый путь: Telegram сам скачивает по URL.
 * Если не вышло — скачиваем в Worker и загружаем multipart.
 */
async function deliverVideo(env, chatId, media) {
  if (!media.width || !media.height) {
    const dim = await probeDimensions(media.url);
    if (dim) Object.assign(media, dim);
  }

  const common = {
    chat_id: chatId,
    supports_streaming: true,
    ...(media.width && media.height ? { width: media.width, height: media.height } : {}),
  };

  // Путь 1: по URL
  const byUrl = await tg(env, 'sendVideo', { ...common, video: media.url }, { throwOnError: false });
  if (byUrl.ok) return;
  console.warn('sendVideo by URL failed:', byUrl.description);

  // Путь 2: скачиваем сами
  const fileRes = await fetch(media.url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    cf: { cacheTtl: 0 },
  });
  if (!fileRes.ok) throw new Error(`не скачать файл: HTTP ${fileRes.status}`);
  const ctype = fileRes.headers.get('content-type') || '';
  if (/^image\//i.test(ctype)) {
    throw new Error('источник отдал картинку вместо видео — Instagram не отдаёт этот ролик без логина');
  }

  const len = Number(fileRes.headers.get('content-length') || 0);
  if (len > TG_UPLOAD_LIMIT) {
    throw new Error(`файл ${(len / 1e6).toFixed(0)} МБ — больше лимита Telegram в 50 МБ`);
  }

  const buf = await fileRes.arrayBuffer();
  if (buf.byteLength > TG_UPLOAD_LIMIT) {
    throw new Error('файл больше лимита Telegram в 50 МБ');
  }

  const form = new FormData();
  for (const [k, v] of Object.entries(common)) form.append(k, String(v));
  const fname = (media.filename || 'reel.mp4').replace(/\.[a-z0-9]+$/i, '') + '.mp4';
  form.append('video', new Blob([buf], { type: 'video/mp4' }), fname);

  const up = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendVideo`, {
    method: 'POST',
    body: form,
  }).then((r) => r.json());

  if (!up.ok) throw new Error(`Telegram: ${up.description}`);
}

/** Обёртка над Bot API. */
async function tg(env, method, payload, { throwOnError = true } = {}) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok && throwOnError) throw new Error(`Telegram ${method}: ${data.description}`);
  return data;
}
