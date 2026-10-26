// Админка: вход по паролю, управление персонажами, загрузка картинок.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { httpError, sendJson, readBody, readJson, parseCookies, clientIp, isHttps, SUPPORTED_LANGS } = require('./util');

const PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const COOKIE = 'admin_session';
const MAX_UPLOAD = 3 * 1024 * 1024;

// Ключ для подписи сессии получается из пароля (и необязательного SESSION_SECRET).
// Сменили пароль в .env: все старые входы перестают действовать.
const KEY = crypto.createHash('sha256')
  .update('session-key:' + (process.env.SESSION_SECRET || '') + ':' + PASSWORD)
  .digest();

const sign = (text) => crypto.createHmac('sha256', KEY).update(text).digest('hex');

function makeToken() {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return `${exp}.${sign(exp)}`;
}

function tokenValid(token) {
  if (!token) return false;
  const [exp, sig] = String(token).split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function passwordMatches(input) {
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Не больше 5 неудачных попыток входа за 15 минут с одного IP
const attempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (rec.resetAt < Date.now()) { attempts.delete(ip); return false; }
  return rec.count >= MAX_ATTEMPTS;
}
function registerFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < Date.now()) attempts.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else rec.count += 1;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) if (rec.resetAt < now) attempts.delete(ip);
}, 60000).unref();

function isAuthed(req) {
  return tokenValid(parseCookies(req.headers.cookie)[COOKIE]);
}

// Защита от запросов с чужих сайтов: если браузер прислал Origin, он должен совпадать с адресом сайта
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}

// ---------- проверка данных персонажа ----------

const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const IMAGE_RE = /^(\/uploads\/[A-Za-z0-9._-]+|images\/characters\/[A-Za-z0-9._-]+)$/;

function text(body, key, label, { min = 0, max }) {
  const v = typeof body[key] === 'string' ? body[key].trim() : '';
  if (v.length < min) throw httpError(400, `Поле «${label}» обязательно.`);
  if (v.length > max) throw httpError(400, `Поле «${label}» длиннее ${max} символов.`);
  return v;
}

function parseGenres(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const out = [];
  for (const g of list) {
    const name = String(g).trim();
    if (!name) continue;
    if (name.length > 30) throw httpError(400, 'Название жанра длиннее 30 символов.');
    if (!out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  if (out.length > 6) throw httpError(400, 'Не больше 6 жанров у одного персонажа.');
  return out;
}

function validateCharacter(body, { creating }) {
  const value = {};
  if (creating) {
    value.id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!ID_RE.test(value.id)) {
      throw httpError(400, 'Идентификатор: 2–32 символа, только латиница в нижнем регистре, цифры и дефис.');
    }
  }
  value.name = text(body, 'name', 'Имя', { min: 1, max: 40 });
  value.tagline = text(body, 'tagline', 'Подпись', { max: 120 });
  value.avatar = text(body, 'avatar', 'Эмодзи', { max: 40 }) || '💬';
  if ([...value.avatar].length > 12) throw httpError(400, 'Эмодзи: слишком длинное значение.');
  value.image = typeof body.image === 'string' ? body.image.trim() : '';
  if (value.image && !IMAGE_RE.test(value.image)) throw httpError(400, 'Недопустимый путь к картинке.');
  value.genres = parseGenres(body.genres);
  value.greeting = text(body, 'greeting', 'Приветствие', { min: 1, max: 500 });
  value.systemPrompt = text(body, 'systemPrompt', 'Инструкция для ИИ', { min: 1, max: 4000 });
  // Переводы: {"en": {name, tagline, genres, greeting}}. Пустые поля берутся из русской версии.
  if (body.translations !== undefined) {
    const src = body.translations && typeof body.translations === 'object' ? body.translations : {};
    value.translations = {};
    for (const lang of SUPPORTED_LANGS) {
      if (lang === 'ru' || !src[lang] || typeof src[lang] !== 'object') continue;
      const tr = src[lang];
      const entry = {
        name: text(tr, 'name', 'Имя (перевод)', { max: 40 }),
        tagline: text(tr, 'tagline', 'Подпись (перевод)', { max: 120 }),
        genres: parseGenres(tr.genres),
        greeting: text(tr, 'greeting', 'Приветствие (перевод)', { max: 500 }),
      };
      if (entry.name || entry.tagline || entry.genres.length || entry.greeting) value.translations[lang] = entry;
    }
  }
  value.published = body.published === undefined ? true : !!body.published;
  if (body.sortOrder !== undefined && body.sortOrder !== null && body.sortOrder !== '') {
    const n = Number(body.sortOrder);
    if (!Number.isInteger(n) || Math.abs(n) > 1000000) throw httpError(400, 'Порядок должен быть целым числом.');
    value.sortOrder = n;
  }
  return value;
}

// ---------- картинки ----------

function detectImage(buf) {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  return null;
}

// ---------- фото персонажей для чата ----------

const MAX_PHOTOS = 20; // фото на одного персонажа

const photoDto = (p) => ({ id: p.id, url: '/photos/' + p.file, title: p.title, tags: p.tags, description: p.description });

function parseTags(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const out = [];
  for (const t of list) {
    const tag = String(t).trim();
    if (!tag) continue;
    if (tag.length > 30) throw httpError(400, 'Ключевое слово длиннее 30 символов.');
    if (!out.some((x) => x.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  if (out.length > 15) throw httpError(400, 'Не больше 15 ключевых слов у одного фото.');
  return out;
}

function validatePhotoMeta(body) {
  return {
    title: text(body, 'title', 'Тема', { max: 60 }),
    tags: parseTags(body.tags),
    description: text(body, 'description', 'Описание', { max: 300 }),
  };
}

function removePhotoFile(photo) {
  fs.rm(path.join(db.PHOTOS_DIR, photo.file), { force: true }, () => {});
}

function removeUploadIfUnused(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  if (db.isImageInUse(url)) return;
  const file = path.join(db.UPLOADS_DIR, path.basename(url));
  fs.rm(file, { force: true }, () => {});
}

// ---------- маршруты ----------

async function handle(req, res, pathname) {
  if (!PASSWORD) {
    return sendJson(res, 503, { error: 'Админка выключена: задайте ADMIN_PASSWORD в файле .env и перезапустите сервер.' });
  }
  const method = req.method;
  if (method !== 'GET' && !sameOrigin(req)) throw httpError(403, 'Запрос с чужого сайта отклонён.');

  // вход и выход
  if (pathname === '/api/admin/login' && method === 'POST') {
    const ip = clientIp(req);
    if (tooManyAttempts(ip)) throw httpError(429, 'Слишком много попыток входа. Подождите 15 минут.');
    const body = await readJson(req, 4 * 1024);
    if (typeof body.password !== 'string' || !passwordMatches(body.password)) {
      registerFailure(ip);
      throw httpError(401, 'Неверный пароль.');
    }
    attempts.delete(ip);
    const cookie = `${COOKIE}=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${isHttps(req) ? '; Secure' : ''}`;
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }
  if (pathname === '/api/admin/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }

  // всё остальное только для вошедшего
  if (!isAuthed(req)) throw httpError(401, 'Нужно войти.');

  if (pathname === '/api/admin/me' && method === 'GET') return sendJson(res, 200, { ok: true });

  if (pathname === '/api/admin/characters' && method === 'GET') {
    return sendJson(res, 200, db.listCharacters({ onlyPublished: false }));
  }

  if (pathname === '/api/admin/characters' && method === 'POST') {
    const value = validateCharacter(await readJson(req), { creating: true });
    if (db.getCharacter(value.id)) throw httpError(409, 'Персонаж с таким идентификатором уже есть.');
    return sendJson(res, 201, db.createCharacter(value));
  }

  // Идентификатор берём любой, какой есть в базе (например, заглавные буквы у персонажей,
  // попавших из characters.json). Строгие правила действуют только при создании нового.
  const m = pathname.match(/^\/api\/admin\/characters\/([^/]{1,64})$/);
  if (m && method === 'PUT') {
    const old = db.getCharacter(m[1]);
    if (!old) throw httpError(404, 'Персонаж не найден.');
    const value = validateCharacter(await readJson(req), { creating: false });
    if (value.sortOrder === undefined) value.sortOrder = old.sortOrder;
    if (value.translations === undefined) value.translations = old.translations; // не стираем переводы, если их не прислали
    const saved = db.updateCharacter(m[1], value);
    if (old.image !== saved.image) removeUploadIfUnused(old.image);
    return sendJson(res, 200, saved);
  }
  if (m && method === 'DELETE') {
    const old = db.getCharacter(m[1]);
    if (!old) throw httpError(404, 'Персонаж не найден.');
    const photos = db.listPhotos(m[1]);
    db.deleteCharacter(m[1]); // записи о фото удаляются вместе с персонажем
    photos.forEach(removePhotoFile);
    removeUploadIfUnused(old.image);
    return sendJson(res, 200, { ok: true });
  }

  // фото персонажа: список и загрузка
  const pm = pathname.match(/^\/api\/admin\/characters\/([^/]{1,64})\/photos$/);
  if (pm) {
    if (!db.getCharacter(pm[1])) throw httpError(404, 'Персонаж не найден.');
    if (method === 'GET') return sendJson(res, 200, db.listPhotos(pm[1]).map(photoDto));
    if (method === 'POST') {
      const type = String(req.headers['content-type'] || '').toLowerCase();
      if (!/^image\/(png|jpeg|webp)$/.test(type)) throw httpError(415, 'Нужен файл PNG, JPG или WebP.');
      if (db.countPhotos(pm[1]) >= MAX_PHOTOS) throw httpError(409, `Не больше ${MAX_PHOTOS} фото на одного персонажа.`);
      const buf = await readBody(req, MAX_UPLOAD);
      const ext = detectImage(buf);
      if (!ext) throw httpError(400, 'Файл не похож на PNG, JPG или WebP.');

      // Имя файла становится темой и ключевым словом: «пляж.jpg» даёт тему «пляж»
      const rawName = new URL(req.url, 'http://localhost').searchParams.get('name') || '';
      const stem = rawName.replace(/[\u0000-\u001f]/g, '').replace(/\.[^.]*$/, '').replace(/[_]+/g, ' ').trim().slice(0, 60);
      const title = stem || 'Фото';
      const id = crypto.randomBytes(8).toString('hex');
      const file = id + ext;
      fs.writeFileSync(path.join(db.PHOTOS_DIR, file), buf);
      const photo = db.addPhoto({
        id, characterId: pm[1], file, title,
        tags: stem ? [stem.toLowerCase()] : [],
        description: '',
      });
      return sendJson(res, 201, photoDto(photo));
    }
  }

  // отдельное фото: правка темы и ключевых слов, удаление
  const phm = pathname.match(/^\/api\/admin\/photos\/([a-f0-9]{16})$/);
  if (phm) {
    const photo = db.getPhoto(phm[1]);
    if (!photo) throw httpError(404, 'Фото не найдено.');
    if (method === 'PUT') {
      const saved = db.updatePhoto(phm[1], validatePhotoMeta(await readJson(req)));
      return sendJson(res, 200, photoDto(saved));
    }
    if (method === 'DELETE') {
      db.deletePhoto(phm[1]);
      removePhotoFile(photo);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/admin/upload' && method === 'POST') {
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!/^image\/(png|jpeg|webp)$/.test(type)) throw httpError(415, 'Нужен файл PNG, JPG или WebP.');
    const buf = await readBody(req, MAX_UPLOAD);
    const ext = detectImage(buf); // формат определяем по содержимому, а не по заявленному типу
    if (!ext) throw httpError(400, 'Файл не похож на PNG, JPG или WebP.');
    const name = crypto.randomBytes(9).toString('hex') + ext;
    fs.writeFileSync(path.join(db.UPLOADS_DIR, name), buf);
    return sendJson(res, 201, { url: '/uploads/' + name });
  }

  throw httpError(404, 'Не найдено.');
}

module.exports = { handle, enabled: !!PASSWORD, passwordLength: PASSWORD.length };
