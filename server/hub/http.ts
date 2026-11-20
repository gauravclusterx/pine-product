/** The real HttpFn connectors use: fetch with a timeout, JSON in and out. */
import type { HttpFn, HttpRequest, HttpResponse } from "./types.js";

export const fetchHttp: HttpFn = async (req: HttpRequest): Promise<HttpResponse> => {
  const url = new URL(req.url);
  for (const [k, v] of Object.entries(req.query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { accept: "application/json", ...(req.headers || {}) };
  let body: string | undefined;
  if (req.body !== undefined) {
    if (typeof req.body === "string") body = req.body;
    else { body = JSON.stringify(req.body); headers["content-type"] = headers["content-type"] || "application/json"; }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, { method: req.method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    let data: any = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => { out[k] = v; });
    return { status: res.status, data, headers: out };
  } finally {
    clearTimeout(timer);
  }
};

/** Process-local TTL cache, one namespace per integration. Tokens and reference data only. */
const store = new Map<string, { value: unknown; expires: number }>();
export function cacheFor(namespace: string) {
  return {
    get<T>(key: string): T | undefined {
      const hit = store.get(`${namespace}:${key}`);
      if (!hit) return undefined;
      if (hit.expires < Date.now()) { store.delete(`${namespace}:${key}`); return undefined; }
      return hit.value as T;
    },
    set<T>(key: string, value: T, ttlSeconds: number) {
      store.set(`${namespace}:${key}`, { value, expires: Date.now() + ttlSeconds * 1000 });
      if (store.size > 50_000) for (const [k, v] of store) if (v.expires < Date.now()) store.delete(k);
    },
  };
}
export function clearCache(namespace?: string) {
  if (!namespace) { store.clear(); return; }
  for (const k of store.keys()) if (k.startsWith(namespace + ":")) store.delete(k);
}
