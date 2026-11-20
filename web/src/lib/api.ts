/** Typed fetch wrapper. Session = httpOnly cookie; writes carry the CSRF header; org chosen by header. */

export class ApiError extends Error {
  status: number;
  code: string;
  fields?: Array<{ field: string; message: string }>;
  constructor(status: number, code: string, message: string, fields?: Array<{ field: string; message: string }>) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

const ORG_KEY = "pine.org";
export function currentOrgId(): string {
  try { return localStorage.getItem(ORG_KEY) || ""; } catch { return ""; }
}
export function setCurrentOrgId(id: string) {
  try { localStorage.setItem(ORG_KEY, id); } catch { /* private mode */ }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; org?: boolean } = {}): Promise<T> {
  const method = opts.method || "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-pine-csrf"] = "1";
  const org = currentOrgId();
  if (org && opts.org !== false) headers["x-org-id"] = org;
  const res = await fetch(`/api${path}`, { method, headers, credentials: "same-origin", body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const e = data?.error || {};
    throw new ApiError(res.status, e.code || "error", e.message || `Request failed (${res.status})`, e.fields);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body?: unknown) => api<T>(p, { method: "POST", body: body ?? {} });
export const put = <T = any>(p: string, body?: unknown) => api<T>(p, { method: "PUT", body: body ?? {} });
export const patch = <T = any>(p: string, body?: unknown) => api<T>(p, { method: "PATCH", body: body ?? {} });
export const del = <T = any>(p: string) => api<T>(p, { method: "DELETE" });
