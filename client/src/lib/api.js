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

export async function authenticate() {
  const tg = window.Telegram?.WebApp;
  tg?.ready?.();
  tg?.expand?.();
  const existingToken = getToken();
  if (!tg?.initData && existingToken) {
    return { token: existingToken, existing: true };
  }
  if (!tg?.initData) {
    throw new Error('Откройте Академию через кнопку в Telegram. Прямой вход по ссылке закрыт.');
  }
  const unsafeUser = tg?.initDataUnsafe?.user || null;
  const payload = {
    initData: tg?.initData || '',
    unsafeUser
  };
  const data = await apiFetch('/auth/telegram', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  setToken(data.token);
  return data;
}
