import { ReactNode, useEffect } from "react";
import { X, Loader2 } from "lucide-react";
import { ApiError } from "../lib/api";
import { OUTCOME_LABEL, OUTCOME_TONE } from "../lib/format";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-ink-mute mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone = "default" }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "default" | "leaf" | "plum" }) {
  const ring = tone === "leaf" ? "before:bg-leaf" : tone === "plum" ? "before:bg-plum-soft" : "before:bg-canvas-line";
  return (
    <div className={`card p-5 relative overflow-hidden before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${ring}`}>
      <div className="text-xs font-medium text-ink-mute">{label}</div>
      <div className="text-3xl font-semibold mt-1 font-display tabular-nums">{value}</div>
      {hint && <div className="text-xs text-ink-mute mt-1">{hint}</div>}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card p-10 text-center">
      <div className="mx-auto mb-3 h-10 w-10 rounded-full bg-canvas-deep" />
      <div className="font-medium">{title}</div>
      {body && <div className="text-sm text-ink-mute mt-1 max-w-md mx-auto">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="flex items-center gap-2 text-sm text-ink-mute p-6"><Loader2 className="h-4 w-4 animate-spin" /> {label}</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div className="rounded-xl border border-bad/20 bg-bad-wash text-bad text-sm px-3 py-2">
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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/30 p-4 pt-16" onMouseDown={onClose}>
      <div className={`card w-full ${wide ? "max-w-3xl" : "max-w-lg"} p-6 shadow-lift`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{title}</h2>
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
    live: "bg-leaf-wash text-leaf-dark", connected: "bg-leaf-wash text-leaf-dark", running: "bg-leaf-wash text-leaf-dark", booked: "bg-leaf-wash text-leaf-dark", active: "bg-leaf-wash text-leaf-dark",
    draft: "bg-canvas-deep text-ink-soft", scheduled: "bg-plum-wash text-plum", paused: "bg-warn-wash text-warn", queued: "bg-plum-wash text-plum", calling: "bg-plum-wash text-plum", new: "bg-plum-wash text-plum",
    error: "bg-bad-wash text-bad", failed: "bg-bad-wash text-bad", rejected: "bg-bad-wash text-bad", lost: "bg-canvas-deep text-ink-mute", cancelled: "bg-canvas-deep text-ink-mute",
    completed: "bg-canvas-deep text-ink-soft", contacted: "bg-canvas-deep text-ink-soft", rescheduled: "bg-plum-wash text-plum",
    unverified: "bg-warn-wash text-warn",
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
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-sm">
      <span className={`relative h-6 w-10 rounded-full transition-colors ${checked ? "bg-leaf" : "bg-canvas-line"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
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
          <div className="w-full rounded-t-md bg-canvas-deep relative" style={{ height: `${(d.a / max) * (height - 22)}px` }}>
            {d.b != null && <div className="absolute bottom-0 left-0 right-0 rounded-t-md bg-leaf" style={{ height: `${d.a ? (d.b / d.a) * 100 : 0}%` }} />}
          </div>
          <div className="text-[10px] text-ink-mute truncate w-full text-center">{d.label}</div>
        </div>
      ))}
    </div>
  );
}
