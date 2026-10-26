// Логика фото в чате: понять, что пользователь просит фото, и выбрать подходящее по теме.
// Выбор фото собран в pickPhoto(). Когда подключите облачную генерацию изображений,
// достаточно заменить вызов pickPhoto() в server.js на запрос к генератору.

// Приводим текст к простому виду: строчные буквы, «ё» как «е», без знаков препинания
const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/ё/g, 'е')
  .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Слова «фото» (русские и английские)
const NOUN_RE = new RegExp(
  '(?<![\\p{L}])(?:' + [
    'фото', 'фотк[аиуео]', 'фоток', 'фотографи[яиюй]', 'фотографиях', 'селфи',
    'картинк[аиуео]', 'картинок', 'снимок', 'снимк[аиуо]', 'пикч[ауи]', 'изображени[еяюй]',
    'photos?', 'pictures?', 'pics?', 'selfies?', 'images?',
  ].join('|') + ')(?![\\p{L}])',
  'gu'
);

// Слова просьбы: «пришли», «покажи», «можно», «send me» и т. п.
const REQUEST_RE = new RegExp(
  '(?<![\\p{L}])(?:' + [
    'пришл\\p{L}*', 'присл\\p{L}*', 'скин\\p{L}*', 'кинь', 'кину', 'отправ\\p{L}*',
    'покаж\\p{L}*', 'показ\\p{L}*', 'дай', 'дашь', 'даш\\p{L}*', 'сдела\\p{L}*', 'можно',
    'хоч\\p{L}*', 'хотел\\p{L}*', 'увидеть', 'посмотр\\p{L}*', 'глянуть',
    'есть ли', 'есть у тебя', 'у тебя есть',
    'send', 'show', 'share', 'give', 'can i see', 'could i see', 'let me see',
    'want to see', 'wanna see', 'like to see', 'do you have', 'have you got', 'got any', 'need',
  ].join('|') + ')(?![\\p{L}])',
  'gu'
);

const WINDOW = 50; // слово просьбы и слово «фото» должны стоять рядом

// Просит ли пользователь фото. Нужно и слово «фото», и слово просьбы рядом.
function detectPhotoRequest(text) {
  const t = norm(text);
  if (!t) return false;
  const nouns = [...t.matchAll(NOUN_RE)].map((m) => m.index);
  if (nouns.length === 0) return false;
  const requests = [...t.matchAll(REQUEST_RE)].map((m) => m.index);
  return nouns.some((n) => requests.some((r) => Math.abs(n - r) <= WINDOW));
}

// Выбор фото по теме из сообщения. photos: [{id, title, tags: []}], sentIds: уже показанные в этом диалоге.
// Совпадение: ключевое слово (тег) или тема встречается в тексте (основа слова, «пляж» найдёт «на пляже»).
// Среди равных вариантов предпочитаем ещё не показанные, потом случайный.
function pickPhoto(photos, text, sentIds = [], rng = Math.random) {
  if (!photos.length) return null;
  const t = ' ' + norm(text) + ' ';
  const words = new Set(t.trim().split(' '));

  // У длинных слов отбрасываем окончание, чтобы «собака» находила «собаку» и «собакой»
  const stem = (w) => {
    const s = w.replace(/[аяуюыиоеьй]+$/, '');
    return s.length >= 4 ? s : w;
  };

  const matches = (needle) => {
    const n = norm(needle);
    if (!n) return 0;
    if (n.length < 3) return words.has(n) ? n.length : 0; // короткие слова только целиком
    const s = stem(n);
    return t.includes(s) ? s.length : 0;
  };

  const scored = photos.map((p) => {
    let score = 0;
    for (const tag of p.tags || []) score += matches(tag);
    score += matches(p.title);
    return { photo: p, score };
  });

  const best = Math.max(...scored.map((s) => s.score));
  let pool = best > 0 ? scored.filter((s) => s.score === best) : scored;
  const fresh = pool.filter((s) => !sentIds.includes(s.photo.id));
  if (fresh.length) pool = fresh;
  const chosen = pool[Math.floor(rng() * pool.length)].photo;
  return { photo: chosen, matched: best > 0 };
}

module.exports = { detectPhotoRequest, pickPhoto, norm };
