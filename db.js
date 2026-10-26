// База данных на встроенном в Node модуле node:sqlite (нужен Node 22.13+).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
// Фото для чата лежат отдельно от аватарок: так их не получить напрямую через /uploads/
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Миграции: каждая следующая версия схемы добавляется в конец массива.
// Так позже можно будет добавить таблицы пользователей и диалогов, не трогая существующие данные.
const MIGRATIONS = [
  `CREATE TABLE characters (
     id            TEXT PRIMARY KEY,
     name          TEXT NOT NULL,
     tagline       TEXT NOT NULL DEFAULT '',
     avatar        TEXT NOT NULL DEFAULT '💬',
     image         TEXT NOT NULL DEFAULT '',
     genres        TEXT NOT NULL DEFAULT '[]',
     greeting      TEXT NOT NULL,
     system_prompt TEXT NOT NULL,
     published     INTEGER NOT NULL DEFAULT 1,
     sort_order    INTEGER NOT NULL DEFAULT 0,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL
   )`,
  // Версия 2: переводы персонажей. Хранятся как JSON вида {"en": {name, tagline, genres, greeting}}.
  // Новый язык добавляется без изменений в базе: достаточно ещё одного ключа.
  `ALTER TABLE characters ADD COLUMN translations TEXT NOT NULL DEFAULT '{}'`,
  // Версия 3: фотографии персонажей для отправки в чате. Файлы лежат в data/photos/.
  `CREATE TABLE character_photos (
     id           TEXT PRIMARY KEY,
     character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
     file         TEXT NOT NULL,
     title        TEXT NOT NULL DEFAULT '',
     tags         TEXT NOT NULL DEFAULT '[]',
     description  TEXT NOT NULL DEFAULT '',
     created_at   TEXT NOT NULL
   );
   CREATE INDEX idx_photos_character ON character_photos(character_id)`,
];

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
migrate();

function rowToCharacter(r) {
  let genres = [];
  try { genres = JSON.parse(r.genres); } catch (e) { /* оставляем пустой список */ }
  let translations = {};
  try { translations = JSON.parse(r.translations || '{}') || {}; } catch (e) { /* без переводов */ }
  return {
    translations,
    id: r.id,
    name: r.name,
    tagline: r.tagline,
    avatar: r.avatar,
    image: r.image,
    genres,
    greeting: r.greeting,
    systemPrompt: r.system_prompt,
    published: !!r.published,
    sortOrder: r.sort_order,
  };
}

const ORDER = 'ORDER BY sort_order ASC, created_at ASC, id ASC';

function listCharacters({ onlyPublished }) {
  const sql = `SELECT * FROM characters ${onlyPublished ? 'WHERE published = 1' : ''} ${ORDER}`;
  return db.prepare(sql).all().map(rowToCharacter);
}

function getCharacter(id, { onlyPublished } = {}) {
  const sql = `SELECT * FROM characters WHERE id = ? ${onlyPublished ? 'AND published = 1' : ''}`;
  const row = db.prepare(sql).get(id);
  return row ? rowToCharacter(row) : null;
}

function createCharacter(c) {
  const now = new Date().toISOString();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM characters').get().m;
  const sortOrder = Number.isInteger(c.sortOrder) ? c.sortOrder : max + 1;
  db.prepare(
    `INSERT INTO characters
     (id, name, tagline, avatar, image, genres, greeting, system_prompt, published, sort_order, created_at, updated_at, translations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    c.id, c.name, c.tagline, c.avatar, c.image, JSON.stringify(c.genres),
    c.greeting, c.systemPrompt, c.published ? 1 : 0, sortOrder, now, now,
    JSON.stringify(c.translations || {})
  );
  return getCharacter(c.id);
}

function updateCharacter(id, c) {
  const result = db.prepare(
    `UPDATE characters SET name = ?, tagline = ?, avatar = ?, image = ?, genres = ?,
       greeting = ?, system_prompt = ?, published = ?, sort_order = ?, updated_at = ?, translations = ?
     WHERE id = ?`
  ).run(
    c.name, c.tagline, c.avatar, c.image, JSON.stringify(c.genres),
    c.greeting, c.systemPrompt, c.published ? 1 : 0, c.sortOrder, new Date().toISOString(),
    JSON.stringify(c.translations || {}), id
  );
  return result.changes > 0 ? getCharacter(id) : null;
}

function deleteCharacter(id) {
  return db.prepare('DELETE FROM characters WHERE id = ?').run(id).changes > 0;
}

// ---------- фото персонажей ----------

function rowToPhoto(r) {
  let tags = [];
  try { tags = JSON.parse(r.tags); } catch (e) { /* без тегов */ }
  return { id: r.id, characterId: r.character_id, file: r.file, title: r.title, tags, description: r.description };
}

function listPhotos(characterId) {
  return db.prepare('SELECT * FROM character_photos WHERE character_id = ? ORDER BY created_at ASC, id ASC')
    .all(characterId).map(rowToPhoto);
}

function getPhoto(id) {
  const row = db.prepare('SELECT * FROM character_photos WHERE id = ?').get(id);
  return row ? rowToPhoto(row) : null;
}

function countPhotos(characterId) {
  return db.prepare('SELECT COUNT(*) AS n FROM character_photos WHERE character_id = ?').get(characterId).n;
}

function addPhoto(p) {
  db.prepare(
    `INSERT INTO character_photos (id, character_id, file, title, tags, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(p.id, p.characterId, p.file, p.title, JSON.stringify(p.tags), p.description, new Date().toISOString());
  return getPhoto(p.id);
}

function updatePhoto(id, p) {
  const r = db.prepare('UPDATE character_photos SET title = ?, tags = ?, description = ? WHERE id = ?')
    .run(p.title, JSON.stringify(p.tags), p.description, id);
  return r.changes > 0 ? getPhoto(id) : null;
}

function deletePhoto(id) {
  return db.prepare('DELETE FROM character_photos WHERE id = ?').run(id).changes > 0;
}

// Нужна ли ещё картинка из /uploads/: используется ли она каким-то персонажем
function isImageInUse(url) {
  return !!db.prepare('SELECT 1 FROM characters WHERE image = ? LIMIT 1').get(url);
}

// Первый запуск: если таблица пуста, переносим персонажей из characters.json
function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM characters').get().n;
  if (count > 0) return 0;
  const file = path.join(__dirname, 'characters.json');
  if (!fs.existsSync(file)) return 0;
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const usedIds = new Set();
  list.forEach((c, i) => {
    // Идентификаторы из файла приводим к правилам админки: строчная латиница, цифры, дефис
    let id = String(c.id || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    if (id.length < 2) id = `character-${i + 1}`;
    while (usedIds.has(id)) id = `${id.slice(0, 28)}-${i + 1}`;
    usedIds.add(id);
    if (id !== c.id) console.warn(`characters.json: идентификатор «${c.id}» заменён на «${id}»`);
    createCharacter({
      id,
      name: c.name,
      tagline: c.tagline || '',
      avatar: c.avatar || '💬',
      image: c.image || '',
      genres: c.genres || [],
      greeting: c.greeting,
      systemPrompt: c.systemPrompt,
      published: true,
      sortOrder: i + 1,
      translations: c.en ? { en: c.en } : {},
    });
  });
  return list.length;
}

// База, созданная до появления языков: подставляем английские версии трёх примеров,
// но только если у персонажа нет переводов и его русский текст не менялся.
function addSampleTranslations() {
  const file = path.join(__dirname, 'characters.json');
  if (!fs.existsSync(file)) return 0;
  let n = 0;
  for (const sample of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    if (!sample.en) continue;
    const row = getCharacter(sample.id);
    if (!row || Object.keys(row.translations).length > 0) continue;
    if (row.name !== sample.name || row.greeting !== sample.greeting) continue;
    updateCharacter(row.id, { ...row, translations: { en: sample.en } });
    n++;
  }
  return n;
}

module.exports = {
  DATA_DIR,
  UPLOADS_DIR,
  PHOTOS_DIR,
  listPhotos,
  getPhoto,
  countPhotos,
  addPhoto,
  updatePhoto,
  deletePhoto,
  listCharacters,
  getCharacter,
  createCharacter,
  updateCharacter,
  deleteCharacter,
  isImageInUse,
  seedIfEmpty,
  addSampleTranslations,
};
