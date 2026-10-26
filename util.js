// Небольшие помощники для HTTP-сервера на встроенном модуле http.

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

// Читает тело запроса целиком, но не больше limit байт
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) return reject(httpError(413, 'Слишком большой запрос.'));
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        chunks.length = 0;
        reject(httpError(413, 'Слишком большой запрос.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
    req.on('aborted', () => reject(httpError(400, 'Запрос прерван.')));
  });
}

async function readJson(req, limit = 100 * 1024) {
  const type = String(req.headers['content-type'] || '');
  if (!type.toLowerCase().startsWith('application/json')) {
    throw httpError(415, 'Ожидается JSON.');
  }
  const raw = await readBody(req, limit);
  try {
    const data = JSON.parse(raw.toString('utf8') || '{}');
    if (data === null || typeof data !== 'object') throw new Error('not object');
    return data;
  } catch (e) {
    throw httpError(400, 'Некорректный JSON.');
  }
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

// IP клиента. За прокси (Render, nginx и т.п.) включите TRUST_PROXY=1 в .env
function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

function isHttps(req) {
  if (req.socket.encrypted) return true;
  return process.env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// Языки сайта. Чтобы добавить новый, допишите его код сюда, в словарь public/i18n.js
// и в сообщения сервера (MESSAGES в server.js).
const SUPPORTED_LANGS = ['ru', 'en'];
const pickLang = (value) => (SUPPORTED_LANGS.includes(value) ? value : 'ru');

module.exports = { httpError, sendJson, readBody, readJson, parseCookies, clientIp, isHttps, SUPPORTED_LANGS, pickLang };
