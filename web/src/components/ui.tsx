import { ReactNode, useEffect, useId, useMemo, useState } from "react";
import { X, Loader2 } from "lucide-react";
import { ApiError } from "../lib/api";
import { OUTCOME_LABEL, OUTCOME_TONE } from "../lib/format";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-7">
      <div className="min-w-0">
        <h1 className="text-[34px] leading-[1.1] text-ink">{title}</h1>
        {subtitle && <p className="text-sm text-ink-mute mt-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A KPI tile: label, a big serif number, and a sage note. `tone="roi"` is the highlighted tile. */
export function Stat({ label, value, hint, tone = "default" }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "default" | "leaf" | "plum" | "roi" }) {
  return (
    <div className={`rounded-2xl p-5 ${tone === "roi" ? "card-roi" : "glass"}`}>
      <div className="text-[13px] text-ink-soft">{label}</div>
      <div className="num text-[38px] leading-[1.1] mt-2 text-ink">{value}</div>
      {hint && <div className="text-[13px] text-leaf mt-1.5">{hint}</div>}
    </div>
  );
}

/** Segmented range picker, like the dashboard's 30 d / 90 d / 6 mo. */
export function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card p-10 text-center">
      <div className="mx-auto mb-4 h-11 w-11 rounded-2xl bg-leaf-wash shadow-glow" />
      <div className="font-display text-xl text-ink">{title}</div>
      {body && <div className="text-sm text-ink-mute mt-1.5 max-w-md mx-auto">{body}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="flex items-center gap-2 text-sm text-ink-mute p-6"><Loader2 className="h-4 w-4 animate-spin text-leaf" /> {label}</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div className="rounded-xl shadow-[inset_0_0_0_1px_rgba(242,164,155,0.25)] bg-bad-wash text-bad text-sm px-3 py-2">
      {e.message || "Something went wrong."}
      {e.fields?.length ? <ul className="mt-1 list-disc pl-5">{e.fields.map((f) => <li key={f.field}>{f.field}: {f.message}</li>)}</ul> : null}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 pt-16" onMouseDown={onClose}>
      <div className={`w-full ${wide ? "max-w-3xl" : "max-w-lg"} rounded-3xl p-6 bg-canvas-solid shadow-lift`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-display text-2xl text-ink">{title}</h2>
          <button className="btn-ghost btn-sm" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function OutcomeChip({ outcome }: { outcome: string | null | undefined }) {
  const o = outcome || "in_progress";
  return <span className={`chip ${OUTCOME_TONE[o] || "bg-canvas-deep text-ink-mute"}`}>{OUTCOME_LABEL[o] || o.replace(/_/g, " ")}</span>;
}

export function StatusChip({ status }: { status: string }) {
  const tone: Record<string, string> = {
    live: "bg-leaf-wash text-leaf", connected: "bg-leaf-wash text-leaf", running: "bg-leaf-wash text-leaf", booked: "bg-leaf-wash text-leaf", active: "bg-leaf-wash text-leaf",
    draft: "bg-canvas-deep text-ink-soft", scheduled: "bg-plum-wash text-plum", paused: "bg-warn-wash text-warn", queued: "bg-plum-wash text-plum", calling: "bg-plum-wash text-plum", new: "bg-plum-wash text-plum",
    error: "bg-bad-wash text-bad", failed: "bg-bad-wash text-bad", rejected: "bg-bad-wash text-bad", lost: "bg-canvas-deep text-ink-mute", cancelled: "bg-canvas-deep text-ink-mute",
    completed: "bg-canvas-deep text-ink-soft", contacted: "bg-canvas-deep text-ink-soft", rescheduled: "bg-plum-wash text-plum",
    unverified: "bg-warn-wash text-warn", churned: "bg-canvas-deep text-ink-mute",
  };
  return <span className={`chip ${tone[status] || "bg-canvas-deep text-ink-soft"}`}>{status.replace(/_/g, " ")}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-mute mt-1">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-sm text-ink-soft">
      <span className={`relative h-6 w-10 rounded-full transition-colors shadow-card ${checked ? "bg-leaf" : "bg-black/30"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full shadow transition-all ${checked ? "left-[18px] bg-[#0B1409]" : "left-0.5 bg-ink-mute"}`} />
      </span>
      {label}
    </button>
  );
}

/** A tiny dependency-free bar chart. */
export function Bars({ data, height = 140 }: { data: Array<{ label: string; a: number; b?: number }>; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.a));
  return (
    <div className="flex items-end gap-1.5" style={{ height }}>
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0" title={`${d.label}: ${d.a} calls${d.b != null ? `, ${d.b} booked` : ""}`}>
          <div className="w-full rounded-t-md bg-white/10 relative" style={{ height: `${(d.a / max) * (height - 22)}px` }}>
            {d.b != null && <div className="absolute bottom-0 left-0 right-0 rounded-t-md bg-leaf" style={{ height: `${d.a ? (d.b / d.a) * 100 : 0}%` }} />}
          </div>
          <div className="text-[10px] text-ink-mute truncate w-full text-center">{d.label}</div>
        </div>
      ))}
    </div>
  );
}

/** Smooth path through points (monotone cubic), so the line never overshoots. */
function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : "";
  const n = pts.length;
  const dx: number[] = [], m: number[] = [], t: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / (dx[i] || 1); }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${pts[i][0] + h},${pts[i][1] + t[i] * h} ${pts[i + 1][0] - h},${pts[i + 1][1] - t[i + 1] * h} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

/**
 * Area chart in the dashboard style: a sage line with a soft fill, an optional dashed comparison
 * line, a y-axis in money, and a pill on the last point.
 */
export function AreaChart({ points, compare, format, labelEnd, height = 300 }: {
  points: Array<{ x: string; y: number }>;
  compare?: number[];
  format: (v: number) => string;
  labelEnd?: string;
  height?: number;
}) {
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000, H = height, padL = 64, padR = 28, padT = 26, padB = 34;
  const geo = useMemo(() => {
    const all = [...points.map((p) => p.y), ...(compare || [])];
    const rawMax = Math.max(1, ...all);
    const step = niceStep(rawMax / 3);
    const max = Math.ceil(rawMax / step) * step;
    const x = (i: number) => padL + (points.length <= 1 ? 0 : (i / (points.length - 1)) * (W - padL - padR));
    const y = (v: number) => padT + (1 - v / max) * (H - padT - padB);
    const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
    return { max, x, y, ticks };
  }, [points, compare, H]);
  if (!points.length) return <div className="text-sm text-ink-mute py-16 text-center">No data in this period yet.</div>;
  const pts = points.map((p, i) => [geo.x(i), geo.y(p.y)] as [number, number]);
  const line = smoothPath(pts);
  const area = `${line} L${pts[pts.length - 1][0]},${H - padB} L${pts[0][0]},${H - padB} Z`;
  const cmp = compare && compare.length === points.length ? smoothPath(compare.map((v, i) => [geo.x(i), geo.y(v)] as [number, number])) : "";
  const last = pts[pts.length - 1];
  const every = Math.max(1, Math.ceil(points.length / 6));
  const active = hover ?? points.length - 1;
  const a = pts[active];
  const pillText = hover == null && labelEnd ? labelEnd : `${format(points[active].y)} · ${points[active].x}`;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" preserveAspectRatio="none" role="img" aria-label="Chart"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - padL) / (W - padL - padR)) * (points.length - 1));
          setHover(Math.min(points.length - 1, Math.max(0, i)));
        }}>
        <defs>
          <linearGradient id={`f${id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#B7D3A8" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#B7D3A8" stopOpacity="0" />
          </linearGradient>
        </defs>
        {geo.ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={geo.y(t)} y2={geo.y(t)} stroke="rgba(255,255,255,0.07)" />
            <text x={padL - 12} y={geo.y(t) + 5} textAnchor="end" fontSize="15" fill="rgba(242,246,240,0.55)">{format(t)}</text>
          </g>
        ))}
        <line x1={pts[0][0]} x2={pts[0][0]} y1={padT} y2={H - padB} stroke="rgba(255,255,255,0.25)" strokeDasharray="2 5" />
        <path d={area} fill={`url(#f${id})`} />
        {cmp && <path d={cmp} fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="2" strokeDasharray="7 7" />}
        <path d={line} fill="none" stroke="#DCEBD2" strokeWidth="3" strokeLinecap="round" />
        {points.map((p, i) => (i % every === 0 || i === points.length - 1) && (
          <text key={i} x={geo.x(i)} y={H - 8} textAnchor="middle" fontSize="15" fill="rgba(242,246,240,0.45)">{p.x}</text>
        ))}
        {hover != null && <line x1={a[0]} x2={a[0]} y1={padT} y2={H - padB} stroke="rgba(255,255,255,0.18)" />}
        <circle cx={a[0]} cy={a[1]} r="9" fill="#F2F6F0" stroke="#29561F" strokeWidth="4" />
        {hover == null && <circle cx={last[0]} cy={last[1]} r="9" fill="#F2F6F0" stroke="#29561F" strokeWidth="4" />}
      </svg>
      <div className="pointer-events-none absolute -translate-x-full -translate-y-1/2 whitespace-nowrap rounded-full bg-ink text-[#0B1409] text-xs sm:text-sm font-medium px-3 py-1.5 shadow-lg"
        style={{ left: `${(a[0] / W) * 100 - 1.5}%`, top: `${((a[1] + 46) / H) * 100}%` }}>
        {pillText}
      </div>
    </div>
  );
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
