const TOKEN_KEY = 'atlas_admin_token';

export class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

/** JSON fetch. A 401 asks the owner once for ADMIN_TOKEN (kept in localStorage) and retries. */
export async function api(path, { method = 'GET', body, retry = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && retry) {
    const entered = window.prompt('This action is for the owner. Enter ADMIN_TOKEN:');
    if (entered) { localStorage.setItem(TOKEN_KEY, entered.trim()); return api(path, { method, body, retry: false }); }
  }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  return data;
}
