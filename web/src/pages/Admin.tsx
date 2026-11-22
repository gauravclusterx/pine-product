import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Building2, Plus } from "lucide-react";
import { get, post, put } from "../lib/api";
import { money, moneyShort, num, when } from "../lib/format";
import { useSession } from "../lib/session";
import { AreaChart, ErrorNote, Field, Loading, Modal, PageHeader, Segmented, Stat, StatusChip } from "../components/ui";

const RANGES = [{ value: 30, label: "30 d" }, { value: 90, label: "90 d" }, { value: 180, label: "6 mo" }];

function cumulative(rows: Array<{ day: string; billed_cents: number; calls: number }>, days: number) {
  const fmt = (d: Date) => d.toLocaleString("en-US", days > 120 ? { month: "short", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" });
  let billed = 0;
  return rows.map((r) => { billed += r.billed_cents; return { x: fmt(new Date(r.day)), y: billed }; });
}

/** Admin home: the whole platform at a glance, in the same style as a client's dashboard. */
export function AdminOverview() {
  const [days, setDays] = useState(30);
  const nav = useNavigate();
  const { switchOrg } = useSession();
  const { data: d, isLoading, error } = useQuery({ queryKey: ["admin-overview", days], queryFn: () => get(`/admin/overview?days=${days}`), refetchInterval: 60_000 });
  const queue = useQuery({ queryKey: ["admin-queue"], queryFn: () => get("/admin/queue"), refetchInterval: 30_000 });
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const pts = cumulative(d.daily, days);
  const dead = (queue.data?.queues || []).filter((x: any) => x.status === "dead").reduce((a: number, x: any) => a + x.count, 0);
  const rangeLabel = days === 180 ? "6 months" : `${days} days`;
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="eyebrow">Admin panel</p>
          <h1 className="text-[34px] sm:text-[40px] leading-[1.08] text-ink mt-2">Pine AI platform</h1>
          <p className="text-[15px] text-ink-mute mt-2">{num(d.orgs.total)} clients · {num(d.orgs.live_agents)} live agents · last {rangeLabel}</p>
        </div>
        <Segmented value={days} options={RANGES} onChange={setDays} />
      </div>

      <div className="mt-7 grid gap-6 xl:grid-cols-[1fr_330px]">
        <div className="min-w-0">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <Stat label="Active clients" value={num(d.orgs.active)} hint={`+${num(d.orgs.new_in_range)} new · ${num(d.orgs.voice_connected)} with voice`} />
            <Stat label="Calls handled" value={num(d.calls.total)} hint={`${num(d.calls.minutes)} billable minutes`} />
            <Stat label="Jobs booked for clients" value={num(d.bookings.total)} hint={`${moneyShort(d.bookings.value_cents)} booked revenue`} />
            <Stat label="Billed" value={moneyShort(d.calls.charge_cents)} hint={rangeLabel} tone="roi" />
          </div>
          <div className="mt-4 rounded-2xl well p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3 mb-2">
              <h2 className="text-[15px] text-ink-soft">Billed usage across all clients</h2>
              <span className="inline-flex items-center gap-2 text-xs text-ink-mute"><i className="inline-block w-4 h-[2px] bg-leaf" />Cumulative billing</span>
            </div>
            <AreaChart points={pts} format={(v) => moneyShort(v)} labelEnd={pts.length ? `${moneyShort(pts[pts.length - 1].y)} billed` : undefined} />
          </div>
        </div>

        <aside className="xl:border-l xl:border-white/10 xl:pl-6">
          <div className="flex items-baseline justify-between">
            <h2 className="eyebrow">Top clients</h2>
            <Link to="/admin/clients" className="text-xs text-leaf hover:underline">All clients</Link>
          </div>
          <div className="mt-4 space-y-3">
            {d.topClients.length ? d.topClients.map((c: any) => (
              <button key={c.id} onClick={() => { switchOrg(c.id); nav("/app"); }} className="w-full text-left glass rounded-2xl p-4 flex gap-3.5 hover:bg-white/[0.07] transition">
                <div className="h-11 w-11 shrink-0 rounded-xl bg-white/[0.07] shadow-card grid place-items-center text-ink-soft"><Building2 className="h-4 w-4" /></div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink truncate">{c.name}</div>
                  <div className="text-[13px] text-leaf mt-1">✓ {num(c.booked)} booked · {num(c.calls)} calls</div>
                  <div className="text-xs text-ink-mute mt-1 capitalize">{c.industry.replace(/_/g, " ")}</div>
                </div>
                <div className="text-right shrink-0"><div className="num text-[22px] text-ink">{moneyShort(c.charge_cents)}</div><div className="text-xs text-ink-mute">billed</div></div>
              </button>
            )) : <div className="glass rounded-2xl p-5 text-sm text-ink-mute">No clients yet. <Link to="/admin/clients" className="text-leaf underline">Add the first one</Link>.</div>}
          </div>
          <div className={`mt-4 rounded-2xl p-4 text-sm ${dead ? "bg-bad-wash text-bad" : "glass text-ink-soft"}`}>
            <div className="eyebrow mb-1">System</div>
            {dead ? <>{dead} background jobs failed. <Link to="/admin/system" className="underline">Look</Link></> : "Background work is healthy."}
            <div className="text-xs text-ink-mute mt-1">{num(d.orgs.users)} people can sign in.</div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function AdminClients() {
  const { switchOrg } = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const orgs = useQuery({ queryKey: ["admin-orgs"], queryFn: () => get("/admin/orgs") });
  const usage = useQuery({ queryKey: ["admin-usage"], queryFn: () => get("/admin/usage") });
  const [create, setCreate] = useState(false);
  const [voiceFor, setVoiceFor] = useState<any>(null);
  if (orgs.isLoading) return <Loading />;
  const usageBy = new Map((usage.data?.orgs || []).map((u: any) => [u.id, u]));
  return (
    <div>
      <PageHeader title="Clients" subtitle="Every business on Pine AI: voice workspace, rate and this month's usage." actions={<button className="btn-primary" onClick={() => setCreate(true)}><Plus className="h-4 w-4" /> New client</button>} />
      <ErrorNote error={orgs.error} />
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[860px]">
          <thead><tr><th className="th">Client</th><th className="th">Voice</th><th className="th">Live agents</th><th className="th">Rate / min</th><th className="th">This month</th><th className="th">Status</th><th className="th"></th></tr></thead>
          <tbody>{orgs.data?.orgs.map((o: any) => {
            const u: any = usageBy.get(o.id);
            return (
              <tr key={o.id} className="hover:bg-white/[0.03]">
                <td className="td"><div className="font-medium text-ink">{o.name}</div><div className="text-xs text-ink-mute capitalize">{o.industry.replace(/_/g, " ")} · since {when(o.created_at, { dateStyle: "medium" })}</div></td>
                <td className="td">{o.voice_connected ? <StatusChip status="connected" /> : <span className="chip bg-warn-wash text-warn">not connected</span>}</td>
                <td className="td tabular-nums">{o.live_agents}</td>
                <td className="td"><RateCell org={o} onSaved={() => qc.invalidateQueries({ queryKey: ["admin-orgs"] })} /></td>
                <td className="td tabular-nums">{u ? `${Math.ceil(u.seconds / 60)} min · ${money(u.charge_cents)}` : "—"}</td>
                <td className="td"><StatusChip status={o.status} /></td>
                <td className="td text-right whitespace-nowrap">
                  <button className="btn-line btn-sm" onClick={() => setVoiceFor(o)}>Voice key</button>
                  <button className="btn-ghost btn-sm" onClick={() => { switchOrg(o.id); nav("/app"); }}>Open <ArrowUpRight className="h-3.5 w-3.5" /></button>
                </td>
              </tr>
            );
          })}</tbody>
        </table>
        {!orgs.data?.orgs.length && <div className="p-10 text-center text-sm text-ink-mute">No clients yet.</div>}
      </div>
      <NewClient open={create} onClose={() => setCreate(false)} />
      {voiceFor && <VoiceKey org={voiceFor} onClose={() => { setVoiceFor(null); qc.invalidateQueries({ queryKey: ["admin-orgs"] }); }} />}
    </div>
  );
}

export function AdminSystem() {
  const queue = useQuery({ queryKey: ["admin-queue"], queryFn: () => get("/admin/queue"), refetchInterval: 15_000 });
  if (queue.isLoading) return <Loading />;
  return (
    <div>
      <PageHeader title="System" subtitle="Background work: calls to sync, leads to dial, messages to send." />
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {(queue.data?.queues || []).map((x: any) => (
          <div key={x.queue + x.status} className={`rounded-2xl p-5 ${x.status === "dead" ? "bg-bad-wash" : "glass"}`}>
            <div className="text-[13px] text-ink-soft">{x.queue}</div>
            <div className="num text-[34px] mt-1">{num(x.count)}</div>
            <div className={`text-[13px] mt-1 ${x.status === "dead" ? "text-bad" : "text-leaf"}`}>{x.status}</div>
          </div>
        ))}
      </div>
      {!queue.data?.queues?.length && <div className="card p-8 text-center text-sm text-ink-mute">Idle — nothing waiting.</div>}
      {queue.data?.dead?.length > 0 && (
        <div className="card mt-6 p-5">
          <h2 className="eyebrow mb-3">Failed jobs</h2>
          <div className="text-sm space-y-2 max-h-96 overflow-y-auto">{queue.data.dead.map((d: any) => <div key={d.id} className="text-bad"><span className="text-ink-mute">{when(d.finished_at)} · {d.queue} #{d.id}:</span> {d.last_error}</div>)}</div>
        </div>
      )}
    </div>
  );
}

function RateCell({ org, onSaved }: { org: any; onSaved: () => void }) {
  const [v, setV] = useState(String(org.rate_cents_per_minute / 100));
  const m = useMutation({ mutationFn: () => put(`/admin/orgs/${org.id}/rate`, { centsPerMinute: Math.round(Number(v) * 100) }), onSuccess: onSaved });
  return <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="flex items-center gap-1 text-ink-mute">$<input className="input h-8 w-20" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => Number(v) * 100 !== org.rate_cents_per_minute && m.mutate()} aria-label="Rate per minute" /></form>;
}

function NewClient({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { refresh } = useSession();
  const [f, setF] = useState({ name: "", industry: "hvac", timezone: "America/New_York", ownerEmail: "", ownerName: "", rateCentsPerMinute: 25 });
  const [result, setResult] = useState<any>(null);
  const m = useMutation({ mutationFn: () => post("/admin/orgs", f), onSuccess: (r) => { setResult(r); qc.invalidateQueries({ queryKey: ["admin-orgs"] }); qc.invalidateQueries({ queryKey: ["admin-overview"] }); refresh(); } });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  const close = () => { setResult(null); onClose(); };
  return (
    <Modal open={open} onClose={close} title="New client">
      {result ? (
        <div className="space-y-3 text-sm">
          <div className="rounded-xl bg-leaf-wash text-leaf px-3 py-2">{result.org.name} is ready.</div>
          <div className="text-ink-soft"><b className="text-ink">{result.owner.email}</b> {result.owner.existing ? "already had an account and" : ""} is the owner. They sign in with Google using this email — no password needed.</div>
          <div className="text-ink-mute">Next: connect their voice workspace key, then build their first agent.</div>
          <button className="btn-primary w-full" onClick={close}>Done</button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <Field label="Business name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Industry"><select className="input" value={f.industry} onChange={(e) => setF({ ...f, industry: e.target.value })}>{["hvac", "plumbing", "roofing", "solar", "electrical", "pest_control", "garage_door", "cleaning", "other"].map((i) => <option key={i} value={i}>{i.replace(/_/g, " ")}</option>)}</select></Field>
            <Field label="Time zone"><input className="input" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Owner Google email"><input className="input" type="email" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} required /></Field>
            <Field label="Owner name"><input className="input" value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></Field>
          </div>
          <Field label="Rate per minute ($)"><input className="input w-32" type="number" step="0.01" min={0} value={f.rateCentsPerMinute / 100} onChange={(e) => setF({ ...f, rateCentsPerMinute: Math.round(Number(e.target.value) * 100) })} /></Field>
          <ErrorNote error={m.error} />
          <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={close}>Cancel</button><button className="btn-primary" disabled={m.isPending}>Create client</button></div>
        </form>
      )}
    </Modal>
  );
}

function VoiceKey({ org, onClose }: { org: any; onClose: () => void }) {
  const [apiKey, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const m = useMutation({ mutationFn: () => put(`/admin/orgs/${org.id}/voice-key`, { apiKey, webhookSecret: secret || undefined }) });
  return (
    <Modal open onClose={onClose} title={`Voice workspace · ${org.name}`}>
      <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-3">
        <p className="text-sm text-ink-mute">Each client has its own voice workspace and key. The key is checked, stored encrypted, and never shown again.</p>
        <Field label="Workspace API key"><input className="input" type="password" autoComplete="off" value={apiKey} onChange={(e) => setKey(e.target.value)} required /></Field>
        <Field label="Webhook signing secret (optional)" hint="Only needed if the call-events webhook already exists at the provider."><input className="input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>
        <ErrorNote error={m.error} />
        {m.data && <div className="rounded-xl bg-leaf-wash text-leaf text-sm px-3 py-2">Connected to {m.data.workspaceId}.{m.data.note ? <div className="text-warn mt-1">{m.data.note}</div> : null}</div>}
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Close</button><button className="btn-primary" disabled={m.isPending}>{m.isPending ? "Checking…" : "Connect"}</button></div>
      </form>
    </Modal>
  );
}
