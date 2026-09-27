export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-requested-with': 'labbook' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  if (res.status === 401 && !url.endsWith('/auth/login') && !url.endsWith('/auth/me')) {
    window.dispatchEvent(new Event('labbook:unauthorized'));
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const d = data as { error?: string; message?: string; details?: unknown } | undefined;
    const details = Array.isArray(d?.details)
      ? (d.details as unknown[]).map((x) =>
          typeof x === 'string' ? x : ((x as { message?: string }).message ?? JSON.stringify(x)),
        )
      : undefined;
    const msg = [d?.error ?? res.statusText, d?.message, details?.join('; ')].filter(Boolean).join(': ');
    throw new ApiError(res.status, msg, d?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export function qs(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}
