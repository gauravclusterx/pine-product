import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Plus, Square } from "lucide-react";
import { get, post } from "../lib/api";
import { when } from "../lib/format";
import { useSession } from "../lib/session";
import { Empty, ErrorNote, Field, Loading, Modal, PageHeader, StatusChip } from "../components/ui";

const KINDS: Record<string, { label: string; body: string }> = {
  estimate_followup: { label: "Estimate follow-up", body: "Customers with an open estimate in your CRM." },
  membership_renewal: { label: "Membership renewal", body: "Plans ending in the next 45 days." },
  reactivation: { label: "Reactivation", body: "Past customers with no job for a while." },
  after_job: { label: "After-job check-in", body: "Jobs finished in the last two days." },
  reminder: { label: "Appointment reminders", body: "Appointments tomorrow." },
  custom: { label: "Upload a list", body: "A CSV with a phone column (and any other columns as variables)." },
};

export default function Campaigns() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ["campaigns"], queryFn: () => get("/campaigns"), refetchInterval: 30_000 });
  const cmd = useMutation({ mutationFn: ({ id, c }: { id: string; c: string }) => post(`/campaigns/${id}/${c}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }) });
  return (
    <div>
      <PageHeader title="Campaigns" subtitle="Outbound calling to your own lists — with consent, do-not-call and calling hours checked for you." actions={can("manager") && <button className="btn-primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New campaign</button>} />
      <ErrorNote error={cmd.error} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : !q.data.campaigns.length ? <Empty title="No campaigns yet" body="Fill quiet days: follow up estimates, renew memberships, win back past customers." /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead><tr><th className="th">Campaign</th><th className="th">Agent</th><th className="th">Recipients</th><th className="th">Calls</th><th className="th">Booked</th><th className="th">Status</th><th className="th"></th></tr></thead>
            <tbody>{q.data.campaigns.map((c: any) => (
              <tr key={c.id}>
                <td className="td"><div className="font-medium">{c.name}</div><div className="text-xs text-ink-mute">{KINDS[c.kind]?.label || c.kind} · {when(c.created_at)}</div>{c.last_error && <div className="text-xs text-bad mt-1">{c.last_error}</div>}</td>
                <td className="td text-ink-soft">{c.agent_name}</td>
                <td className="td tabular-nums">{c.recipient_count}{(c.skipped?.do_not_call || c.skipped?.no_consent) ? <div className="text-xs text-ink-mute">{c.skipped.do_not_call} DNC · {c.skipped.no_consent} no consent skipped</div> : null}</td>
                <td className="td tabular-nums">{c.calls}</td>
                <td className="td tabular-nums text-leaf-dark">{c.booked}</td>
                <td className="td"><StatusChip status={c.status} /></td>
                <td className="td text-right whitespace-nowrap">{can("manager") && (
                  <>
                    {c.status === "running" && <button className="btn-ghost btn-sm" onClick={() => cmd.mutate({ id: c.id, c: "pause" })} title="Pause"><Pause className="h-4 w-4" /></button>}
                    {c.status === "paused" && <button className="btn-ghost btn-sm" onClick={() => cmd.mutate({ id: c.id, c: "resume" })} title="Resume"><Play className="h-4 w-4" /></button>}
                    {c.status === "scheduled" && <button className="btn-ghost btn-sm" onClick={() => cmd.mutate({ id: c.id, c: "start" })} title="Start"><Play className="h-4 w-4" /></button>}
                    {["running", "paused", "scheduled"].includes(c.status) && <button className="btn-ghost btn-sm text-bad" onClick={() => { if (confirm("Cancel this campaign?")) cmd.mutate({ id: c.id, c: "cancel" }); }} title="Cancel"><Square className="h-4 w-4" /></button>}
                  </>
                )}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <NewCampaign open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function NewCampaign({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => get("/agents"), enabled: open });
  const [f, setF] = useState<any>({ name: "", kind: "estimate_followup", agentId: "", csv: "", inactiveMonths: 12, start: true });
  const m = useMutation({ mutationFn: () => post("/campaigns", { ...f, csv: f.kind === "custom" ? f.csv : undefined }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["campaigns"] }); onClose(); } });
  const live = (agents.data?.agents || []).filter((a: any) => a.status === "live");
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  return (
    <Modal open={open} onClose={onClose} title="New campaign" wide>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required placeholder="Spring tune-up push" /></Field>
        <div>
          <span className="label">Who to call</span>
          <div className="grid sm:grid-cols-2 gap-2">
            {Object.entries(KINDS).map(([k, v]) => (
              <button type="button" key={k} onClick={() => setF({ ...f, kind: k })} className={`text-left rounded-xl border p-3 ${f.kind === k ? "border-leaf bg-leaf-wash" : "border-canvas-line bg-white/[0.03] hover:bg-canvas-tint"}`}>
                <div className="text-sm font-medium">{v.label}</div><div className="text-xs text-ink-mute">{v.body}</div>
              </button>
            ))}
          </div>
        </div>
        {f.kind === "custom" && (
          <Field label="CSV file" hint="First row = column names. Needs a phone column; add a consent column (yes/no) for automated calls.">
            <input type="file" accept=".csv,text/csv" className="text-sm" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setF({ ...f, csv: await file.text() }); }} />
          </Field>
        )}
        {f.kind === "reactivation" && <Field label="No job for at least (months)"><input type="number" className="input w-32" min={1} max={60} value={f.inactiveMonths} onChange={(e) => setF({ ...f, inactiveMonths: Number(e.target.value) })} /></Field>}
        <Field label="Agent" hint={!live.length ? "Publish an outbound agent first." : undefined}>
          <select className="input" value={f.agentId} onChange={(e) => setF({ ...f, agentId: e.target.value })} required>
            <option value="">Choose…</option>{live.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-leaf h-4 w-4" checked={f.start} onChange={(e) => setF({ ...f, start: e.target.checked })} /> Start calling now (inside your calling hours)</label>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending}>{m.isPending ? "Preparing…" : "Create campaign"}</button></div>
      </form>
    </Modal>
  );
}
