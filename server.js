const fs = require('fs');
const path = require('path');
const http = require('http');

// Настройки из файла .env (если он есть). Переменные окружения хостинга имеют приоритет.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const db = require('./db');
const admin = require('./admin');
const photos = require('./photos');
const { httpError, sendJson, readJson, clientIp, pickLang } = require('./util');

// Сообщения для посетителей на языках сайта (ошибки чата)
const MESSAGES = {
  ru: {
    rate: 'Слишком много сообщений. Подождите минуту.',
    unknownCharacter: 'Неизвестный персонаж.',
    noMessages: 'Нет сообщений.',
    notConfigured: 'Сервер не настроен: укажите API_KEY и MODEL в файле .env.',
    lastNotUser: 'Последнее сообщение должно быть от пользователя.',
    providerLimit: 'Лимит бесплатной модели исчерпан. Попробуйте чуть позже.',
    providerDown: 'Модель сейчас недоступна. Попробуйте ещё раз.',
    emptyReply: 'Модель вернула пустой ответ.',
    generic: 'Что-то пошло не так на сервере.',
    // подсказка модели, на каком языке отвечать по умолчанию
    langHint: 'Интерфейс сайта на русском: если собеседник не пишет на другом языке, отвечай по-русски.',
    // подсказки модели, когда собеседник просит фото
    photoMark: 'фото',
    photoSend: 'Прямо сейчас ты отправляешь собеседнику фото: «{d}». Подпиши его в образе одним-двумя короткими предложениями. Если он просил другую тему, а такого кадра у тебя нет, мягко скажи об этом и предложи этот. Пометки в квадратных скобках в истории служебные, сам их не пиши.',
    photoNone: 'Собеседник просит фото, но отправить его ты не можешь. Мягко откажись в образе одним предложением, ничего не придумывай и не описывай несуществующее фото.',
    photoLocked: 'Собеседник просит фото, но отправка фото сейчас недоступна. Мягко откажи в образе одним предложением, не обещай прислать позже и не описывай несуществующее фото.',
  },
  en: {
    rate: 'Too many messages. Please wait a minute.',
    unknownCharacter: 'Unknown character.',
    noMessages: 'No messages.',
    notConfigured: 'The server is not configured: set API_KEY and MODEL in the .env file.',
    lastNotUser: 'The last message must be from the user.',
    providerLimit: 'The free model limit has been reached. Please try again a little later.',
    providerDown: 'The model is unavailable right now. Please try again.',
    emptyReply: 'The model returned an empty reply.',
    generic: 'Something went wrong on the server.',
    langHint: 'The site interface is in English: unless the user writes in another language, reply in English.',
    photoMark: 'photo',
    photoSend: 'You are sending the user a photo right now: "{d}". Caption it in character with one or two short sentences. If they asked for a different theme and you have no such shot, gently say so and offer this one. Square-bracket notes in the history are internal, never write them yourself.',
    photoNone: 'The user is asking for a photo, but you cannot send one. Gently decline in character in one sentence, do not invent anything and do not describe a photo that does not exist.',
    photoLocked: 'The user is asking for a photo, but sending photos is not available right now. Gently decline in character in one sentence, do not promise to send one later and do not describe a photo that does not exist.',
  },
};

// Показываем персонажа на нужном языке; чего в переводе нет, берём из русской версии
function localize(c, lang) {
  const tr = (lang !== 'ru' && c.translations && c.translations[lang]) || {};
  return {
    id: c.id,
    name: tr.name || c.name,
    tagline: tr.tagline || c.tagline,
    avatar: c.avatar,
    image: c.image,
    genres: tr.genres && tr.genres.length ? tr.genres : c.genres,
    greeting: tr.greeting || c.greeting,
  };
}

const PORT = process.env.PORT || 3000;
const API_BASE_URL = (process.env.API_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const API_KEY = process.env.API_KEY || '';
const MODEL = process.env.MODEL || '';
const MAX_HISTORY = 20;        // сколько последних сообщений отправляем модели
const MAX_MESSAGE_LEN = 2000;  // максимальная длина одного сообщения
const RATE_LIMIT = 20;         // сообщений в минуту с одного IP

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// Не даём страницам подгружать чужие скрипты и встраиваться в чужие сайты
const CSP = "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

// ---------- лимит сообщений в чате ----------
const hits = new Map();
function chatRateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= RATE_LIMIT) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of hits) {
    const recent = times.filter((t) => now - t < 60000);
    if (recent.length) hits.set(ip, recent);
    else hits.delete(ip);
  }
}, 60000).unref();

// ---------- доступ к фото ----------
// PHOTOS_ACCESS=everyone (по умолчанию): фото доступны всем.
// PHOTOS_ACCESS=locked: никому, персонаж вежливо отказывает, а сайт показывает «доступно по подписке».
const PHOTOS_LOCKED = process.env.PHOTOS_ACCESS === 'locked';
// Когда появятся аккаунты и оплата, проверяйте подписку посетителя именно здесь (и в маршруте /photos/ ниже).
function hasPhotoAccess(req) {
  return !PHOTOS_LOCKED;
}

// ---------- чат ----------
async function handleChat(req, res, lang) {
  const M = MESSAGES[lang];
  if (chatRateLimited(clientIp(req))) throw httpError(429, M.rate);

  const { characterId, messages, sentPhotos } = await readJson(req);
  const character = typeof characterId === 'string' ? db.getCharacter(characterId, { onlyPublished: true }) : null;
  if (!character) throw httpError(400, M.unknownCharacter);
  if (!Array.isArray(messages) || messages.length === 0) throw httpError(400, M.noMessages);
  if (!API_KEY || !MODEL) throw httpError(500, M.notConfigured);

  const history = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map((m) => {
      let content = m.content.slice(0, MAX_MESSAGE_LEN);
      // модель должна «помнить», что отправляла фото
      if (m.role === 'assistant' && typeof m.photo === 'string' && m.photo.trim()) {
        content = `[${M.photoMark}: ${m.photo.trim().slice(0, 100)}] ${content}`;
      }
      return { role: m.role, content };
    });
  if (history.length === 0 || history[history.length - 1].role !== 'user') {
    throw httpError(400, M.lastNotUser);
  }

  // ---- фото по просьбе пользователя ----
  let photoHint = '';
  let photo = null;
  let photoLocked = false;
  if (photos.detectPhotoRequest(history[history.length - 1].content)) {
    const available = db.listPhotos(character.id);
    if (available.length === 0) {
      photoHint = M.photoNone;
    } else if (!hasPhotoAccess(req)) {
      photoLocked = true;
      photoHint = M.photoLocked;
    } else {
      const sentIds = Array.isArray(sentPhotos) ? sentPhotos.filter((x) => typeof x === 'string').slice(-100) : [];
      // Здесь выбирается фото. Для облачной генерации заменим этот вызов на запрос к генератору.
      const picked = photos.pickPhoto(available, history[history.length - 1].content, sentIds).photo;
      photo = { id: picked.id, url: '/photos/' + picked.file, title: picked.title };
      photoHint = M.photoSend.replace('{d}', picked.description || picked.title || '');
    }
  }

  const upstream = await fetch(`${API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: [character.systemPrompt, M.langHint, photoHint].filter(Boolean).join('\n\n') },
        ...history,
      ],
      temperature: 0.9,
      max_tokens: 500,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '');
    console.error(`Провайдер вернул ${upstream.status}: ${body.slice(0, 300)}`);
    if (upstream.status === 429) throw httpError(503, M.providerLimit);
    throw httpError(502, M.providerDown);
  }
  const data = await upstream.json();
  const rawReply = data?.choices?.[0]?.message?.content?.trim();
  if (!rawReply) throw httpError(502, M.emptyReply);
  // если модель повторила служебную пометку «[фото: ...]», убираем её
  const reply = rawReply.replace(/^\s*\[(?:фото|photo)[^\]]*\]\s*/i, '').trim() || rawReply;
  const out = { reply };
  if (photo) out.photo = photo;
  if (photoLocked) out.photoLocked = true;
  sendJson(res, 200, out);
}

// ---------- статические файлы ----------
function serveFile(req, res, baseDir, relPath, { immutable = false, cacheControl } = {}) {
  if (relPath.includes('\0')) throw httpError(400, 'Плохой путь.');
  const full = path.join(baseDir, relPath);
  const inside = full === baseDir || full.startsWith(baseDir + path.sep);
  const hidden = relPath.split(/[\\/]/).some((part) => part.startsWith('.'));
  let stat;
  try { stat = inside && !hidden ? fs.statSync(full) : null; } catch (e) { stat = null; }
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Не найдено');
  }
  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Content-Length': stat.size,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': cacheControl || (immutable ? 'public, max-age=86400, immutable' : 'no-cache'),
  };
  if (type.startsWith('text/html')) {
    headers['Content-Security-Policy'] = CSP;
    headers['X-Frame-Options'] = 'DENY';
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).pipe(res);
}

// ---------- маршруты ----------
async function route(req, res) {
  let pathname, lang;
  try {
    const url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
    lang = pickLang(url.searchParams.get('lang'));
  } catch (e) {
    throw httpError(400, 'Плохой адрес.');
  }

  if (pathname === '/api/characters' && req.method === 'GET') {
    return sendJson(res, 200, db.listCharacters({ onlyPublished: true }).map((c) => localize(c, lang)));
  }
  if (pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res, lang);
  if (pathname.startsWith('/api/admin/')) return admin.handle(req, res, pathname);
  if (pathname.startsWith('/api/')) throw httpError(404, 'Не найдено.');

  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Метод не поддерживается.');

  // Фото из чата. Имена случайные и нигде не публикуются, адрес известен только тому, кому фото отправили.
  // Если фото станут платными, проверку доступа добавляйте здесь.
  if (pathname.startsWith('/photos/')) {
    const name = pathname.slice('/photos/'.length);
    if (!/^[a-f0-9]{16}\.(png|jpg|webp)$/.test(name)) throw httpError(404, 'Не найдено.');
    return serveFile(req, res, db.PHOTOS_DIR, name, { cacheControl: 'private, max-age=86400' });
  }
  if (pathname.startsWith('/uploads/')) {
    return serveFile(req, res, db.UPLOADS_DIR, pathname.slice('/uploads/'.length), { immutable: true });
  }
  const rel = pathname.endsWith('/') ? pathname + 'index.html' : pathname;
  return serveFile(req, res, PUBLIC_DIR, rel.slice(1));
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) {
      let lang = 'ru';
      try { lang = pickLang(new URL(req.url, 'http://localhost').searchParams.get('lang')); } catch (e) { /* русский по умолчанию */ }
      sendJson(res, status, { error: err.status ? err.message : MESSAGES[lang].generic });
    } else {
      res.end();
    }
  }
});
server.on('clientError', (err, socket) => socket.destroy());

const seeded = db.seedIfEmpty();
if (seeded) console.log(`База создана, перенесено персонажей: ${seeded}`);
const translated = db.addSampleTranslations();
if (translated) console.log(`Добавлены английские версии для примеров: ${translated}`);

server.listen(PORT, () => {
  console.log(`Сайт запущен: http://localhost:${PORT}`);
  if (!API_KEY || !MODEL) console.warn('Внимание: API_KEY или MODEL не заданы, чат отвечать не будет.');
  if (!admin.enabled) console.warn('Админка выключена: задайте ADMIN_PASSWORD в .env, чтобы включить её (/admin.html).');
  else if (admin.passwordLength < 8) console.warn('Пароль админки короче 8 символов, лучше сделать длиннее.');
});
