const TOKEN_KEY = 'academylh_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`/api${path}`, { ...options, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) clearToken();
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

function getLaunchParam(name) {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const hashParams = new URLSearchParams(hash);
  const searchParams = new URLSearchParams(window.location.search);
  return hashParams.get(name) || searchParams.get(name) || '';
}

function extractUnsafeUser(initData, tg) {
  if (tg?.initDataUnsafe?.user) return tg.initDataUnsafe.user;
  const rawUser = new URLSearchParams(initData).get('user');
  if (!rawUser) return null;
  try {
    return JSON.parse(rawUser);
  } catch {
    return null;
  }
}

export async function authenticate() {
  const tg = window.Telegram?.WebApp;
  tg?.ready?.();
  tg?.expand?.();
  const initData = tg?.initData || getLaunchParam('tgWebAppData');
  const existingToken = getToken();
  if (!initData && existingToken) {
    return { token: existingToken, existing: true };
  }
  if (!initData) {
    throw new Error('Telegram открыл страницу без initData. Проверьте кнопку в PuzzleBot: нужна кнопка Mini App/Web App, не обычная URL-ссылка.');
  }
  const unsafeUser = extractUnsafeUser(initData, tg);
  const payload = {
    initData,
    unsafeUser
  };
  const data = await apiFetch('/auth/telegram', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  setToken(data.token);
  return data;
}
