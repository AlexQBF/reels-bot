/**
 * Instagram Reels → Telegram bot на Cloudflare Workers.
 *
 * Поток: Telegram webhook → Worker → cobalt API (внешний экстрактор)
 *        → прямая ссылка на mp4 → Telegram sendVideo(url).
 * Если Telegram не смог забрать файл по ссылке (>20 МБ, 403 и т.п.),
 * Worker скачивает файл сам и загружает его как multipart (до 50 МБ).
 *
 * Секреты (wrangler secret put ...): BOT_TOKEN, WEBHOOK_SECRET, ALLOWED_USER_ID
 * Переменные (wrangler.toml [vars]): COBALT_INSTANCES — список API-URL через запятую
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
};

async function handleUpdate(update, env) {
  const msg = update.message ?? update.channel_post;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const fromId = String(msg.from?.id ?? msg.chat.id);

  if (env.ALLOWED_USER_ID && fromId !== String(env.ALLOWED_USER_ID)) {
    return; // чужих молча игнорируем
  }

  // Учёт пользователей (если подключено KV-хранилище USERS)
  if (env.USERS) {
    try {
      await trackUser(env.USERS, msg.from);
    } catch (e) {
      console.warn('trackUser failed', e);
    }
  }

  const isOwner = env.OWNER_ID && fromId === String(env.OWNER_ID);
  if (msg.text.startsWith('/stats') && isOwner) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: await buildStats(env.USERS) });
    return;
  }

  if (msg.text.startsWith('/start')) {
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Пришли ссылку на Reels — верну видеофайл.',
    });
    return;
  }

  const match = msg.text.match(INSTAGRAM_RE);
  if (!match) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'Нужна ссылка на Instagram Reels.' });
    return;
  }

  const url = cleanInstagramUrl(match[0]);
  await tg(env, 'sendChatAction', { chat_id: chatId, action: 'upload_video' });

  try {
    const media = await resolveMedia(url, env);
    await deliverVideo(env, chatId, media);
  } catch (e) {
    console.error('failed', url, e);
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `Не получилось: ${e.message ?? e}`,
    });
  }
}

/**
 * Запоминаем пользователя: ключ user:<id>, значение — JSON с датами и счётчиком.
 * Пишем не чаще раза в час на пользователя, чтобы не упираться в лимит KV (1000 записей/сутки).
 */
async function trackUser(kv, from) {
  if (!from?.id) return;
  const key = `user:${from.id}`;
  const now = Date.now();
  const prev = await kv.get(key, 'json');

  if (prev && now - prev.last < 60 * 60 * 1000) return;

  await kv.put(
    key,
    JSON.stringify({
      first: prev?.first ?? now,
      last: now,
      count: (prev?.count ?? 0) + 1,
      username: from.username ?? null,
      name: [from.first_name, from.last_name].filter(Boolean).join(' '),
    }),
  );
}

async function buildStats(kv) {
  if (!kv) return 'KV-хранилище USERS не подключено.';
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  let total = 0;
  let week = 0;
  let today = 0;
  const recent = [];
  let cursor;

  do {
    const page = await kv.list({ prefix: 'user:', cursor });
    for (const k of page.keys) {
      const u = await kv.get(k.name, 'json');
      if (!u) continue;
      total++;
      if (now - u.last < 7 * day) week++;
      if (now - u.last < day) today++;
      recent.push(u);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  recent.sort((a, b) => b.last - a.last);
  const list = recent
    .slice(0, 10)
    .map((u) => `• ${u.username ? '@' + u.username : u.name || 'без имени'} — ${new Date(u.last).toLocaleDateString('ru-RU')}`)
    .join('\n');

  return `Всего пользователей: ${total}\nЗа 7 дней: ${week}\nЗа сутки: ${today}\n\nПоследние:\n${list}`;
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
 *   1. Прямой запрос к внутреннему GraphQL Instagram (быстро, без посредников)
 *   2. Embed-страница Instagram (тоже напрямую)
 *   3. Внешние cobalt-инстансы
 * @returns {Promise<{url: string, filename?: string}>}
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
      ['ig-graphql', igGraphql],
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

/** Способ 1: внутренний GraphQL, которым пользуется сайт Instagram. */
async function igGraphql(shortcode) {
  const body = new URLSearchParams({
    variables: JSON.stringify({
      shortcode,
      fetch_tagged_user_count: null,
      hoisted_comment_id: null,
      hoisted_reply_id: null,
    }),
    doc_id: '8845758582119845',
    lsd: 'AVqbxe3J_YA',
  });

  const res = await fetch('https://www.instagram.com/api/graphql', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-IG-App-ID': '936619743392459',
      'X-FB-LSD': 'AVqbxe3J_YA',
      'X-ASBD-ID': '129477',
      'Sec-Fetch-Site': 'same-origin',
      Origin: 'https://www.instagram.com',
      Referer: `https://www.instagram.com/reel/${shortcode}/`,
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json().catch(() => null);
  const item = json?.data?.xdt_shortcode_media;
  if (!item) throw new Error('нет данных (логин?)');

  const pick = (n) => ({
    url: n.video_url,
    filename: `${shortcode}.mp4`,
    width: n.dimensions?.width,
    height: n.dimensions?.height,
  });

  if (item.is_video && item.video_url) return pick(item);

  // Карусель — первое видео
  const child = item.edge_sidecar_to_children?.edges
    ?.map((e) => e.node)
    .find((n) => n.is_video && n.video_url);
  if (child) return pick(child);

  throw new Error('в посте нет видео');
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
