const TELEGRAM_API = 'https://api.telegram.org';

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
  if (!token || !telegramId) return null;

  const photosUrl = new URL(`/bot${token}/getUserProfilePhotos`, TELEGRAM_API);
  photosUrl.searchParams.set('user_id', String(telegramId));
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
