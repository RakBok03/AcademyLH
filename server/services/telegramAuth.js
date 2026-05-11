import crypto from 'node:crypto';

function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  return { params, hash, dataCheckString };
}

export function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return false;
  const { hash, dataCheckString } = parseInitData(initData);
  if (!hash) return false;
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculated = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(hash));
}

export function extractTelegramUser(initData, unsafeUser = null) {
  if (initData) {
    const params = new URLSearchParams(initData);
    const userRaw = params.get('user');
    if (userRaw) return JSON.parse(userRaw);
  }
  return unsafeUser;
}
