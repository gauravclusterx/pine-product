import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { get, post, put } from "../lib/api";
import { money, when } from "../lib/format";
import { useSession } from "../lib/session";
import { ErrorNote, Field, Loading, Modal, PageHeader, StatusChip } from "../components/ui";

export default function Admin() {
  const { me, switchOrg, refresh } = useSession();
  const qc = useQueryClient();
  const orgs = useQuery({ queryKey: ["admin-orgs"], queryFn: () => get("/admin/orgs"), enabled: !!me?.user.isPlatformAdmin });
  const usage = useQuery({ queryKey: ["admin-usage"], queryFn: () => get("/admin/usage"), enabled: !!me?.user.isPlatformAdmin });
  const queue = useQuery({ queryKey: ["admin-queue"], queryFn: () => get("/admin/queue"), enabled: !!me?.user.isPlatformAdmin, refetchInterval: 15_000 });
  const [create, setCreate] = useState(false);
  const [voiceFor, setVoiceFor] = useState<any>(null);
  if (!me?.user.isPlatformAdmin) return <div className="card p-6 text-sm">Platform staff only.</div>;
  if (orgs.isLoading) return <Loading />;
  const usageBy = new Map((usage.data?.orgs || []).map((u: any) => [u.id, u]));
  return (
    <div>
      <PageHeader title="Platform admin" subtitle="Clients, their voice workspaces, rates and usage." actions={<button className="btn-primary" onClick={() => setCreate(true)}><Plus className="h-4 w-4" /> New client</button>} />
      <ErrorNote error={orgs.error} />
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[820px]">
          <thead><tr><th className="th">Client</th><th className="th">Voice</th><th className="th">Live agents</th><th className="th">Rate / min</th><th className="th">This month</th><th className="th">Status</th><th className="th"></th></tr></thead>
          <tbody>{orgs.data?.orgs.map((o: any) => {
            const u: any = usageBy.get(o.id);
            return (
              <tr key={o.id}>
                <td className="td"><div className="font-medium">{o.name}</div><div className="text-xs text-ink-mute">{o.industry} · since {when(o.created_at, { dateStyle: "medium" })}</div></td>
                <td className="td">{o.voice_connected ? <StatusChip status="connected" /> : <span className="chip bg-warn-wash text-warn">not connected</span>}</td>
                <td className="td tabular-nums">{o.live_agents}</td>
                <td className="td"><RateCell org={o} onSaved={() => qc.invalidateQueries({ queryKey: ["admin-orgs"] })} /></td>
                <td className="td tabular-nums">{u ? `${Math.ceil(u.seconds / 60)} min · ${money(u.charge_cents)}` : "—"}</td>
                <td className="td"><StatusChip status={o.status} /></td>
                <td className="td text-right whitespace-nowrap">
                  <button className="btn-line btn-sm" onClick={() => setVoiceFor(o)}>Voice key</button>
                  <button className="btn-ghost btn-sm" onClick={() => { switchOrg(o.id); refresh(); window.location.href = "/app"; }}>Open</button>
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      <div className="card p-5 mt-4">
        <h2 className="font-semibold mb-2">Background work</h2>
        <div className="flex flex-wrap gap-2 text-xs">{(queue.data?.queues || []).map((x: any) => <span key={x.queue + x.status} className={`chip ${x.status === "dead" ? "bg-bad-wash text-bad" : "bg-canvas-deep text-ink-soft"}`}>{x.queue} · {x.status} · {x.count}</span>)}{!queue.data?.queues?.length && <span className="text-ink-mute">Idle.</span>}</div>
        {queue.data?.dead?.length > 0 && <div className="mt-3 text-xs space-y-1 max-h-40 overflow-y-auto">{queue.data.dead.map((d: any) => <div key={d.id} className="text-bad">{d.queue} #{d.id}: {d.last_error}</div>)}</div>}
      </div>
      <NewClient open={create} onClose={() => setCreate(false)} />
      {voiceFor && <VoiceKey org={voiceFor} onClose={() => { setVoiceFor(null); qc.invalidateQueries({ queryKey: ["admin-orgs"] }); }} />}
    </div>
  );
}

function RateCell({ org, onSaved }: { org: any; onSaved: () => void }) {
  const [v, setV] = useState(String(org.rate_cents_per_minute / 100));
  const m = useMutation({ mutationFn: () => put(`/admin/orgs/${org.id}/rate`, { centsPerMinute: Math.round(Number(v) * 100) }), onSuccess: onSaved });
  return <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="flex items-center gap-1">$<input className="input h-8 w-20" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => Number(v) * 100 !== org.rate_cents_per_minute && m.mutate()} aria-label="Rate per minute" /></form>;
}

function NewClient({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { refresh } = useSession();
  const [f, setF] = useState({ name: "", industry: "hvac", timezone: "America/New_York", ownerEmail: "", ownerName: "", rateCentsPerMinute: 25 });
  const [result, setResult] = useState<any>(null);
  const m = useMutation({ mutationFn: () => post("/admin/orgs", f), onSuccess: (r) => { setResult(r); qc.invalidateQueries({ queryKey: ["admin-orgs"] }); refresh(); } });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  const close = () => { setResult(null); onClose(); };
  return (
    <Modal open={open} onClose={close} title="New client">
      {result ? (
        <div className="space-y-3 text-sm">
          <div className="rounded-xl bg-leaf-wash text-leaf-dark px-3 py-2">{result.org.name} is ready.</div>
          {result.owner.tempPassword ? <div>Owner sign-in: <b>{result.owner.email}</b> with the temporary password <code className="font-mono bg-canvas-deep px-1 rounded">{result.owner.tempPassword}</code> (shown once).</div> : <div>{result.owner.email} already had an account and was added as owner.</div>}
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
            <Field label="Owner email"><input className="input" type="email" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} required /></Field>
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
        {m.data && <div className="rounded-xl bg-leaf-wash text-leaf-dark text-sm px-3 py-2">Connected to {m.data.workspaceId}.{m.data.note ? <div className="text-warn mt-1">{m.data.note}</div> : null}</div>}
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Close</button><button className="btn-primary" disabled={m.isPending}>{m.isPending ? "Checking…" : "Connect"}</button></div>
      </form>
    </Modal>
  );
}
