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
    const media = await resolveViaCobalt(url, env);
    await deliverVideo(env, chatId, media, msg.message_id);
  } catch (e) {
    console.error('failed', url, e);
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      reply_to_message_id: msg.message_id,
      text: `Не получилось: ${e.message ?? e}`,
    });
  }
}

/** Убираем трекинг-параметры (?igsh=..., utm) — cobalt они не нужны. */
function cleanInstagramUrl(raw) {
  const u = new URL(raw);
  u.search = '';
  u.hash = '';
  return u.toString();
}

/**
 * Перебираем cobalt-инстансы по очереди, возвращаем первый успешный результат.
 * @returns {Promise<{url: string, filename?: string}>}
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
async function deliverVideo(env, chatId, media, replyTo) {
  const common = {
    chat_id: chatId,
    reply_to_message_id: replyTo,
    supports_streaming: true,
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
  form.append('video', new Blob([buf], { type: 'video/mp4' }), media.filename || 'reel.mp4');

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
