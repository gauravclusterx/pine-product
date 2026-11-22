/**
 * Admin panel — customers, payments and platform settings (the CRM admin's model):
 * per-customer subscription price + currency, trial, manual activation, wallet credits and rates,
 * voice workspace key, suspension; the global paywall switch and defaults.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Plus, Search } from "lucide-react";
import { get, patch, post, put } from "../lib/api";
import { credits, cur, when } from "../lib/format";
import { useSession } from "../lib/session";
import { ErrorNote, Field, Loading, Modal, PageHeader, StatusChip, Toggle } from "../components/ui";
import { NewClient, VoiceKey } from "./Admin";

const subTone = (c: any) => (c.suspended ? "failed" : c.active ? (c.subscription_status === "trial" ? "scheduled" : "active") : c.subscription_status === "inactive" ? "draft" : "paused");
const subLabel = (c: any) => (c.suspended ? "suspended" : c.active ? c.subscription_status : c.subscription_status === "inactive" ? "no plan" : "expired");

export function AdminCustomers() {
  const q = useQuery({ queryKey: ["admin-customers"], queryFn: () => get("/admin/customers") });
  const [open, setOpen] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [find, setFind] = useState("");
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const rows = (q.data.customers as any[]).filter((c) => !find || `${c.name} ${c.owner_email || ""}`.toLowerCase().includes(find.toLowerCase()));
  return (
    <div>
      <PageHeader title="Customers" subtitle={`${q.data.customers.length} workspaces · paywall ${q.data.settings.paywallEnabled ? "ON" : "OFF"}`}
        actions={<button className="btn-primary" onClick={() => setCreate(true)}><Plus className="h-4 w-4" /> New customer</button>} />
      <div className="relative mb-4 max-w-sm"><Search className="h-4 w-4 absolute left-3 top-3 text-ink-mute" /><input className="input pl-9" placeholder="Search name or email" value={find} onChange={(e) => setFind(e.target.value)} /></div>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[980px]">
          <thead><tr><th className="th">Customer</th><th className="th">Plan</th><th className="th text-right">Price</th><th className="th text-right">Voice credits</th><th className="th text-right">Msg credits</th><th className="th text-right">Calls (month)</th><th className="th">Voice</th><th className="th">Last login</th></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.id} onClick={() => setOpen(c.id)} className="cursor-pointer hover:bg-white/[0.04]">
              <td className="td"><div className="font-medium text-ink">{c.name}</div><div className="text-xs text-ink-mute">{c.owner_email || "no owner"}</div></td>
              <td className="td"><StatusChip status={subTone(c)} /> <span className="text-xs text-ink-mute ml-1">{subLabel(c)}{c.active && (c.subscription_expires_at || c.trial_ends_at) ? ` · ${when(c.subscription_status === "trial" ? c.trial_ends_at : c.subscription_expires_at, { dateStyle: "medium" })}` : ""}</span></td>
              <td className="td text-right tabular-nums">{cur(c.price, c.currency)}</td>
              <td className="td text-right tabular-nums">{credits(c.wallet_voice)}</td>
              <td className="td text-right tabular-nums">{credits(c.wallet_chat)}</td>
              <td className="td text-right tabular-nums">{c.calls_month} <span className="text-ink-mute text-xs">({credits(c.minutes_month)} min)</span></td>
              <td className="td">{c.voice_connected ? <StatusChip status="connected" /> : <span className="chip bg-warn-wash text-warn">not connected</span>}</td>
              <td className="td text-xs text-ink-mute">{c.last_login_at ? when(c.last_login_at) : "never"}</td>
            </tr>
          ))}</tbody>
        </table>
        {!rows.length && <div className="p-10 text-center text-sm text-ink-mute">No customers.</div>}
      </div>
      {open && <CustomerPanel id={open} onClose={() => setOpen(null)} />}
      <NewClient open={create} onClose={() => setCreate(false)} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-2xl well p-4"><h3 className="eyebrow mb-3">{title}</h3>{children}</section>;
}

function CustomerPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { switchOrg } = useSession();
  const q = useQuery({ queryKey: ["admin-customer", id], queryFn: () => get(`/admin/customers/${id}`) });
  const [voiceKey, setVoiceKey] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["admin-customer", id] }); qc.invalidateQueries({ queryKey: ["admin-customers"] }); qc.invalidateQueries({ queryKey: ["admin-payments"] }); };
  const m = useMutation({ mutationFn: (fn: () => Promise<any>) => fn(), onSuccess: refresh });
  const [price, setPrice] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [rates, setRates] = useState<{ v?: string; c?: string; t?: string }>({});
  const [trialDays, setTrialDays] = useState(7);
  const [months, setMonths] = useState(1);
  const [paid, setPaid] = useState("");
  const [cv, setCv] = useState("");
  const [cc, setCc] = useState("");
  if (q.isLoading) return <Modal open onClose={onClose} title="Customer" wide><Loading /></Modal>;
  if (q.error) return <Modal open onClose={onClose} title="Customer" wide><ErrorNote error={q.error} /></Modal>;
  const { org, billing: b, members, payments, ledger, voice, usage } = q.data;
  return (
    <Modal open onClose={onClose} title={org.name} wide>
      <div className="flex flex-wrap items-center gap-2 -mt-2 mb-5 text-sm">
        <StatusChip status={b.suspended ? "failed" : b.active ? "active" : "draft"} />
        <span className="text-ink-mute">{b.suspended ? "suspended" : b.status}{b.expiresAt && b.status !== "trial" ? ` · until ${when(b.expiresAt, { dateStyle: "medium" })}` : ""}{b.status === "trial" && b.trialEndsAt ? ` · trial until ${when(b.trialEndsAt, { dateStyle: "medium" })}` : ""}</span>
        <span className="text-ink-mute">· this month {usage.calls} calls, {credits(usage.minutes)} min, {usage.booked} booked</span>
        <button className="btn-line btn-sm ml-auto" onClick={() => { switchOrg(id); nav("/app"); }}>Open workspace <ArrowUpRight className="h-3.5 w-3.5" /></button>
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <Section title="Subscription">
          <div className="grid grid-cols-[1fr_96px_auto] gap-2 items-end">
            <Field label="Price / month"><input className="input" type="number" min={0} value={price ?? String(b.price)} onChange={(e) => setPrice(e.target.value)} /></Field>
            <Field label="Currency"><select className="input" value={currency ?? b.currency} onChange={(e) => setCurrency(e.target.value)}>{["INR", "USD", "GBP"].map((c) => <option key={c}>{c}</option>)}</select></Field>
            <button className="btn-line h-10" onClick={() => m.mutate(() => patch(`/admin/customers/${id}/billing`, { subscriptionPrice: Number(price ?? b.price), currency: currency ?? b.currency }))}>Save</button>
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2 items-end mt-3">
            <Field label="Grant trial (days)"><input className="input" type="number" min={1} max={365} value={trialDays} onChange={(e) => setTrialDays(Number(e.target.value))} /></Field>
            <button className="btn-line h-10" onClick={() => m.mutate(() => post(`/admin/customers/${id}/trial`, { days: trialDays }))}>Grant trial</button>
          </div>
          <div className="grid grid-cols-[80px_1fr_auto] gap-2 items-end mt-3">
            <Field label="Months"><input className="input" type="number" min={1} max={36} value={months} onChange={(e) => setMonths(Number(e.target.value))} /></Field>
            <Field label={`Amount received (${b.currency}, optional)`}><input className="input" type="number" min={0} value={paid} onChange={(e) => setPaid(e.target.value)} /></Field>
            <button className="btn-primary h-10" onClick={() => m.mutate(() => post(`/admin/customers/${id}/activate`, { months, amount: Number(paid) || 0 }))}>Activate</button>
          </div>
          {b.active && <button className="btn-ghost btn-sm mt-3 text-bad" onClick={() => confirm("End this customer's plan now?") && m.mutate(() => patch(`/admin/customers/${id}/billing`, { endSubscription: true }))}>End plan now</button>}
        </Section>

        <Section title="Credits (prepaid wallet)">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div><div className="text-xs text-ink-mute">Voice (1 / call-minute)</div><div className="num text-3xl">{credits(b.wallet.voice)}</div></div>
            <div><div className="text-xs text-ink-mute">Messages (1 / message)</div><div className="num text-3xl">{credits(b.wallet.chat)}</div></div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input className="input" type="number" min={0} placeholder="Voice credits" value={cv} onChange={(e) => setCv(e.target.value)} />
            <input className="input" type="number" min={0} placeholder="Message credits" value={cc} onChange={(e) => setCc(e.target.value)} />
          </div>
          <div className="flex gap-2 mt-2">
            <button className="btn-primary btn-sm" onClick={() => m.mutate(() => put(`/admin/customers/${id}/credits`, { mode: "add", voice: Number(cv) || 0, chat: Number(cc) || 0 }))}>Add</button>
            <button className="btn-line btn-sm" onClick={() => m.mutate(() => put(`/admin/customers/${id}/credits`, { mode: "set", ...(cv !== "" ? { voice: Number(cv) } : {}), ...(cc !== "" ? { chat: Number(cc) } : {}) }))}>Set exactly</button>
          </div>
          <div className="grid grid-cols-3 gap-2 mt-4 items-end">
            <Field label={`Voice / 1 ${b.currency}`}><input className="input" type="number" step="0.01" value={rates.v ?? String(b.voicePerUnit)} onChange={(e) => setRates({ ...rates, v: e.target.value })} /></Field>
            <Field label={`Msg / 1 ${b.currency}`}><input className="input" type="number" step="0.01" value={rates.c ?? String(b.chatPerUnit)} onChange={(e) => setRates({ ...rates, c: e.target.value })} /></Field>
            <Field label="Top-up tax %"><input className="input" type="number" step="0.5" value={rates.t ?? String(b.taxPercent)} onChange={(e) => setRates({ ...rates, t: e.target.value })} /></Field>
          </div>
          <button className="btn-line btn-sm mt-2" onClick={() => m.mutate(() => patch(`/admin/customers/${id}/billing`, { voicePerUnit: Number(rates.v ?? b.voicePerUnit), chatPerUnit: Number(rates.c ?? b.chatPerUnit), taxPercent: Number(rates.t ?? b.taxPercent) }))}>Save rates</button>
        </Section>

        <Section title="Voice workspace (Rasen)">
          <p className="text-sm text-ink-soft">{voice ? <>Connected · workspace <code className="text-xs">{voice.workspace_id}</code> since {when(voice.created_at, { dateStyle: "medium" })}</> : "Not connected — calls cannot be placed or received."}</p>
          <button className="btn-line btn-sm mt-3" onClick={() => setVoiceKey(true)}>{voice ? "Replace API key" : "Connect API key"}</button>
        </Section>

        <Section title="Account">
          <Toggle checked={b.suspended} onChange={(v) => m.mutate(() => patch(`/admin/customers/${id}/billing`, { suspended: v }))} label={b.suspended ? "Suspended — blocked from the app" : "Active — not suspended"} />
          <div className="mt-4 space-y-1.5 text-sm">
            {members.map((u: any) => <div key={u.id} className="flex justify-between gap-2"><span className="truncate">{u.email}</span><span className="text-ink-mute text-xs">{u.role} · {u.last_login_at ? when(u.last_login_at) : "never signed in"}</span></div>)}
          </div>
          <p className="text-xs text-ink-mute mt-3">{org.industry} · {org.timezone} · since {when(org.created_at, { dateStyle: "medium" })}</p>
        </Section>
      </div>
      <ErrorNote error={m.error} />

      <div className="grid md:grid-cols-2 gap-4 mt-4">
        <Section title="Payments">
          <div className="space-y-1.5 text-sm max-h-48 overflow-y-auto">{payments.length ? payments.map((p: any) => (
            <div key={p.id} className="flex justify-between gap-2"><span>{when(p.created_at, { dateStyle: "medium" })} · {p.kind} · {p.provider}</span><span className="tabular-nums">{cur(p.amount_minor / 100, p.currency)} <span className="text-ink-mute text-xs">{p.status}</span></span></div>
          )) : <div className="text-ink-mute">None yet.</div>}</div>
        </Section>
        <Section title="Credit history">
          <div className="space-y-1.5 text-sm max-h-48 overflow-y-auto">{ledger.length ? ledger.map((l: any, i: number) => (
            <div key={i} className="flex justify-between gap-2"><span>{when(l.created_at)} · {l.kind} · {l.reason}</span><span className={`tabular-nums ${Number(l.delta) > 0 ? "text-leaf" : ""}`}>{Number(l.delta) > 0 ? "+" : ""}{credits(Number(l.delta))}</span></div>
          )) : <div className="text-ink-mute">None yet.</div>}</div>
        </Section>
      </div>
      {voiceKey && <VoiceKey org={org} onClose={() => { setVoiceKey(false); refresh(); }} />}
    </Modal>
  );
}

export function AdminPayments() {
  const q = useQuery({ queryKey: ["admin-payments"], queryFn: () => get("/admin/payments") });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const ok = q.data.payments.filter((p: any) => p.status === "success");
  const byCur = ok.reduce((m: Record<string, number>, p: any) => ({ ...m, [p.currency]: (m[p.currency] || 0) + p.amount_minor / 100 }), {});
  return (
    <div>
      <PageHeader title="Payments" subtitle="Plans and credit top-ups, online and recorded by hand." />
      <div className="grid sm:grid-cols-3 gap-4 mb-6">
        {Object.keys(byCur).length ? Object.entries(byCur).map(([c, v]) => (
          <div key={c} className="glass rounded-2xl p-5"><div className="text-[13px] text-ink-soft">Collected ({c})</div><div className="num text-[36px] mt-1">{cur(v as number, c)}</div></div>
        )) : <div className="glass rounded-2xl p-5 text-sm text-ink-mute">No payments collected yet.</div>}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead><tr><th className="th">Date</th><th className="th">Customer</th><th className="th">For</th><th className="th">Via</th><th className="th text-right">Amount</th><th className="th">Status</th></tr></thead>
          <tbody>{q.data.payments.map((p: any) => (
            <tr key={p.id}><td className="td">{when(p.created_at)}</td><td className="td text-ink">{p.org_name}</td><td className="td">{p.kind === "topup" ? `credits · ${credits(Number(p.voice_credits))} voice, ${credits(Number(p.chat_credits))} msg` : `plan${p.period_end ? ` until ${when(p.period_end, { dateStyle: "medium" })}` : ""}`}</td><td className="td">{p.provider}</td><td className="td text-right tabular-nums">{cur(p.amount_minor / 100, p.currency)}</td><td className="td"><StatusChip status={p.status === "success" ? "completed" : p.status} /></td></tr>
          ))}</tbody>
        </table>
        {!q.data.payments.length && <div className="p-10 text-center text-sm text-ink-mute">No payments yet.</div>}
      </div>
    </div>
  );
}

export function AdminSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-settings"], queryFn: () => get("/admin/settings") });
  const [f, setF] = useState<any>(null);
  const save = useMutation({ mutationFn: (body: any) => put("/admin/settings", body), onSuccess: (d) => { qc.setQueryData(["admin-settings"], d); setF(null); qc.invalidateQueries({ queryKey: ["admin-customers"] }); } });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const s = { ...q.data, ...(f || {}) };
  const set = (k: string, v: any) => setF({ ...(f || {}), [k]: v });
  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" subtitle="Platform-wide billing rules. Per-customer prices and rates override these." />
      <div className="card-roi rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="font-display text-2xl">Subscription required</div>
          <p className="text-sm text-ink-soft mt-1">When ON, a customer without a current plan or trial sees only the plan page. Admins are never blocked.</p>
        </div>
        <Toggle checked={!!q.data.paywallEnabled} onChange={(v) => save.mutate({ paywallEnabled: v })} label={q.data.paywallEnabled ? "ON" : "OFF"} />
      </div>
      <div className="card p-5 mt-4 grid sm:grid-cols-2 gap-4">
        <Field label="Default price / month"><input className="input" type="number" min={0} value={s.defaultSubscriptionPrice} onChange={(e) => set("defaultSubscriptionPrice", Number(e.target.value))} /></Field>
        <Field label="Default currency"><select className="input" value={s.defaultCurrency} onChange={(e) => set("defaultCurrency", e.target.value)}>{["INR", "USD", "GBP"].map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Voice credits per 1 unit of currency" hint="e.g. 0.2 = ₹5 per call-minute"><input className="input" type="number" step="0.01" value={s.defaultVoicePerUnit} onChange={(e) => set("defaultVoicePerUnit", Number(e.target.value))} /></Field>
        <Field label="Message credits per 1 unit of currency" hint="e.g. 2 = ₹0.50 per message"><input className="input" type="number" step="0.01" value={s.defaultChatPerUnit} onChange={(e) => set("defaultChatPerUnit", Number(e.target.value))} /></Field>
        <Field label="Tax on top-ups (%)"><input className="input" type="number" step="0.5" value={s.defaultTaxPercent} onChange={(e) => set("defaultTaxPercent", Number(e.target.value))} /></Field>
        <Field label="Free trial (days, 0 = none)"><input className="input" type="number" min={0} max={365} value={s.trialDays} onChange={(e) => set("trialDays", Number(e.target.value))} /></Field>
        <Field label="Starter voice credits for new customers"><input className="input" type="number" min={0} value={s.starterVoiceCredits} onChange={(e) => set("starterVoiceCredits", Number(e.target.value))} /></Field>
        <Field label="Starter message credits for new customers"><input className="input" type="number" min={0} value={s.starterChatCredits} onChange={(e) => set("starterChatCredits", Number(e.target.value))} /></Field>
      </div>
      <div className="flex items-center gap-3 mt-4">
        <button className="btn-primary" disabled={!f || save.isPending} onClick={() => save.mutate(f)}>Save settings</button>
        <span className="text-xs text-ink-mute">Online payments (Razorpay): {q.data.paymentsOnline ? "connected" : "not set up — add RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET on the server"}</span>
      </div>
      <ErrorNote error={save.error} />
    </div>
  );
}
