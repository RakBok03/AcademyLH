const TELEGRAM_API = 'https://api.telegram.org';
const TELEGRAM_AVATAR_CACHE_TTL_MS = Number(process.env.TELEGRAM_AVATAR_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const TELEGRAM_AVATAR_CACHE_MAX = Number(process.env.TELEGRAM_AVATAR_CACHE_MAX || 1000);

let cachedBotUsername;
const avatarCache = new Map();
const avatarFetches = new Map();

function getCachedAvatar(key) {
  const item = avatarCache.get(key);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    avatarCache.delete(key);
    return null;
  }
  return item.photo;
}

function setCachedAvatar(key, photo) {
  if (avatarCache.size >= TELEGRAM_AVATAR_CACHE_MAX) {
    const oldestKey = avatarCache.keys().next().value;
    if (oldestKey) avatarCache.delete(oldestKey);
  }
  avatarCache.set(key, {
    photo,
    expiresAt: Date.now() + TELEGRAM_AVATAR_CACHE_TTL_MS
  });
}

export async function getTelegramBotUsername() {
  const configured = process.env.TELEGRAM_BOT_USERNAME;
  if (configured) return configured.replace(/^@/, '');
  if (cachedBotUsername !== undefined) return cachedBotUsername;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    cachedBotUsername = null;
    return cachedBotUsername;
  }

  try {
    const response = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
    if (!response.ok) {
      cachedBotUsername = null;
      return cachedBotUsername;
    }
    const data = await response.json();
    cachedBotUsername = data.ok && data.result?.username ? data.result.username : null;
    return cachedBotUsername;
  } catch {
    cachedBotUsername = null;
    return cachedBotUsername;
  }
}

export async function hasTelegramProfilePhoto(telegramId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !telegramId) return false;
  const url = new URL(`/bot${token}/getUserProfilePhotos`, TELEGRAM_API);
  url.searchParams.set('user_id', String(telegramId));
  url.searchParams.set('limit', '1');

  const response = await fetch(url);
  if (!response.ok) return false;
  const data = await response.json();
  return Boolean(data.ok && data.result?.total_count > 0);
}

export async function fetchTelegramProfilePhoto(telegramId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const key = String(telegramId || '');
  if (!token || !key) return null;

  const cached = getCachedAvatar(key);
  if (cached) return cached;
  if (avatarFetches.has(key)) return avatarFetches.get(key);

  const request = fetchTelegramProfilePhotoUncached(token, key)
    .then((photo) => {
      if (photo) setCachedAvatar(key, photo);
      return photo;
    })
    .finally(() => avatarFetches.delete(key));

  avatarFetches.set(key, request);
  return request;
}

async function fetchTelegramProfilePhotoUncached(token, telegramId) {
  const photosUrl = new URL(`/bot${token}/getUserProfilePhotos`, TELEGRAM_API);
  photosUrl.searchParams.set('user_id', telegramId);
  photosUrl.searchParams.set('limit', '1');

  const photosResponse = await fetch(photosUrl);
  if (!photosResponse.ok) return null;
  const photosData = await photosResponse.json();
  const sizes = photosData.result?.photos?.[0];
  const best = sizes?.[sizes.length - 1];
  if (!best?.file_id) return null;

  const fileUrl = new URL(`/bot${token}/getFile`, TELEGRAM_API);
  fileUrl.searchParams.set('file_id', best.file_id);
  const fileResponse = await fetch(fileUrl);
  if (!fileResponse.ok) return null;
  const fileData = await fileResponse.json();
  const filePath = fileData.result?.file_path;
  if (!filePath) return null;

  const photoResponse = await fetch(`${TELEGRAM_API}/file/bot${token}/${filePath}`);
  if (!photoResponse.ok) return null;
  const contentType = photoResponse.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await photoResponse.arrayBuffer());
  return { buffer, contentType };
}

export async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return { skipped: true };

  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
  if (!response.ok) {
    return { ok: false, status: response.status, text: await response.text() };
  }
  return response.json();
}
