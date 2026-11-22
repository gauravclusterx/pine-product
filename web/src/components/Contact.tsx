/**
 * One contact, the ClusterOS CRM way: header (name, phone, email, status, tags), a Conversation tab
 * (voice calls with summary, sentiment, recording and transcript; SMS both ways; send an SMS) and a
 * Details tab (edit everything, notes, latest call analysis, jobs, enquiries, do-not-call).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Bot, Clock, MessageSquare, Mic, Pencil, PhoneCall, PhoneIncoming, PhoneOutgoing, Send, Trash2, User, X } from "lucide-react";
import { currentOrgId, del, get, patch, post } from "../lib/api";
import { ago, duration, SOURCE_LABEL, when } from "../lib/format";
import { useSession } from "../lib/session";
import { ErrorNote, Field, Loading, OutcomeChip, StatusChip } from "./ui";
import { useConfirm } from "./Confirm";

export const STATUS_LABEL: Record<string, string> = {
  fresh: "Fresh", contacted: "Contacted", interested: "Interested", follow_up: "Follow up", callback: "Callback", quote: "Quote",
  booked: "Booked", info: "Info", not_interested: "Not interested", no_contact: "No answer", transferred: "Transferred",
  opt_out: "Opted out", lost: "Lost", won: "Won", unknown: "Unclear",
};
const STATUS_TONE: Record<string, string> = {
  fresh: "bg-warn-wash text-warn", booked: "bg-leaf-wash text-leaf", won: "bg-leaf-wash text-leaf", interested: "bg-leaf-wash text-leaf",
  callback: "bg-plum-wash text-plum", follow_up: "bg-plum-wash text-plum", quote: "bg-plum-wash text-plum", contacted: "bg-plum-wash text-plum",
  not_interested: "bg-bad-wash text-bad", opt_out: "bg-bad-wash text-bad", lost: "bg-bad-wash text-bad",
};
export function ContactStatus({ status }: { status: string }) {
  return <span className={`chip ${STATUS_TONE[status] || "bg-canvas-deep text-ink-soft"}`}>{STATUS_LABEL[status] || status.replace(/_/g, " ")}</span>;
}

const orgQuery = () => { const o = currentOrgId(); return o ? `?org=${o}` : ""; };

function CallItem({ c }: { c: any }) {
  const [tr, setTr] = useState<string[] | null>(null);
  const translate = useMutation({ mutationFn: () => post(`/calls/${c.id}/translate`), onSuccess: (r: any) => setTr(r.lines) });
  const lines: string[] = Array.isArray(c.transcript) ? c.transcript : [];
  const ex = c.extraction || {};
  return (
    <div className="glass rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 shrink-0 rounded-xl bg-white/[0.07] grid place-items-center text-leaf">{c.direction === "inbound" ? <PhoneIncoming className="h-4 w-4" /> : <PhoneOutgoing className="h-4 w-4" />}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-ink">{c.direction === "inbound" ? "Inbound call" : "Outbound call"} · {duration(c.duration_seconds)}{c.agent_name ? ` · ${c.agent_name}` : ""}</span>
            <span className="text-xs text-ink-mute flex items-center gap-1"><Clock className="h-3 w-3" />{ago(c.at)} · {when(c.at)}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5"><OutcomeChip outcome={c.outcome} />{ex.sentiment && <span className="chip bg-white/[0.06] text-ink-soft">Sentiment: {ex.sentiment}</span>}{c.qa_score != null && <span className="chip bg-white/[0.06] text-ink-soft">Score {c.qa_score}</span>}{c.ended_reason && <span className="chip bg-white/[0.06] text-ink-mute">{String(c.ended_reason).replace(/_/g, " ")}</span>}</div>
          {c.summary && <p className="text-sm text-ink-soft mt-2 leading-relaxed"><span className="text-ink">Summary: </span>{c.summary}</p>}
          {ex.callback_time && <p className="text-xs text-plum bg-plum-wash rounded-lg px-2 py-1 mt-2">Next step: call back {ex.callback_time}</p>}
          {c.recording_available && <audio controls preload="none" className="w-full mt-3 h-9" src={`/api/calls/${c.id}/recording${orgQuery()}`} />}
          {lines.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-ink-mute cursor-pointer hover:text-ink select-none">View transcript ({lines.length} lines)</summary>
              <div className="mt-2 rounded-xl well p-3 max-h-64 overflow-y-auto space-y-1 text-xs">
                {(tr || lines).map((l, i) => <div key={i} className={/^AI:/i.test(l) ? "text-leaf" : "text-ink-soft"}>{l}</div>)}
              </div>
              <button className="btn-ghost btn-sm mt-1" onClick={() => translate.mutate()} disabled={translate.isPending}>{translate.isPending ? "Translating…" : "Translate to English"}</button>
              <ErrorNote error={translate.error} />
            </details>
          )}
          <Link to={`/app/calls/${c.id}`} className="text-xs text-ink-mute hover:text-leaf mt-2 inline-block">Open call →</Link>
        </div>
      </div>
    </div>
  );
}

function SmsItem({ m }: { m: any }) {
  const out = m.direction === "out";
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm ${out ? "bg-leaf-wash text-ink rounded-tr-sm" : "bg-white/[0.07] text-ink rounded-tl-sm"}`}>
        <div className="flex items-center gap-1.5 text-[11px] text-ink-mute mb-1">
          {out ? (m.author === "agent" ? <><Bot className="h-3 w-3" /> SMS agent</> : m.author === "human" ? <><User className="h-3 w-3" /> You</> : <><MessageSquare className="h-3 w-3" /> Automatic</>) : <><MessageSquare className="h-3 w-3" /> SMS from customer</>}
          <span>· {when(m.at)}</span>{m.status === "failed" && <span className="text-bad">· not sent</span>}
        </div>
        <div className="whitespace-pre-wrap">{m.body}</div>
        {m.error && <div className="text-[11px] text-bad mt-1">{m.error}</div>}
      </div>
    </div>
  );
}

export function ContactView({ id, onClose, onDeleted }: { id: string; onClose?: () => void; onDeleted?: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"conversation" | "details">("conversation");
  const [editing, setEditing] = useState(false);
  const info = useQuery({ queryKey: ["customer", id], queryFn: () => get(`/customers/${id}`) });
  const conv = useQuery({ queryKey: ["conversation", id], queryFn: () => get(`/customers/${id}/conversation`), refetchInterval: 20_000 });
  const statuses = useQuery({ queryKey: ["customers", "statuses"], queryFn: () => get("/customers?limit=1") });
  const [f, setF] = useState<any>(null);
  const [sms, setSms] = useState("");
  useEffect(() => {
    if (info.data) { const c = info.data.customer; setF({ name: c.name, phone: c.phone, email: c.email, status: c.status, stage: c.stage, notes: c.notes, tags: (c.tags || []).join(", ") }); }
  }, [info.data]);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["customer", id] }); qc.invalidateQueries({ queryKey: ["customers"] }); qc.invalidateQueries({ queryKey: ["conversation", id] }); };
  const save = useMutation({ mutationFn: () => patch(`/customers/${id}`, { ...f, tags: String(f.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean) }), onSuccess: () => { setEditing(false); refresh(); } });
  const quickStatus = useMutation({ mutationFn: (status: string) => patch(`/customers/${id}`, { status }), onSuccess: refresh });
  const send = useMutation({ mutationFn: () => post(`/customers/${id}/sms`, { body: sms }), onSuccess: () => { setSms(""); refresh(); } });
  const call = useMutation({ mutationFn: (agentId: string) => post("/calls", { agentId, phone: info.data.customer.phone }) });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => get("/agents") });
  const remove = useMutation({ mutationFn: () => del(`/customers/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["customers"] }); onDeleted?.(); } });
  const dnc = useMutation({ mutationFn: () => post("/dnc", { phone: info.data.customer.phone, reason: "customer_request" }), onSuccess: refresh });
  const [callAgent, setCallAgent] = useState("");
  const ask = useConfirm();
  if (info.isLoading || !f) return <Loading />;
  if (info.error) return <ErrorNote error={info.error} />;
  const { customer: c, bookings, leads } = info.data;
  const items: any[] = conv.data?.items || [];
  const latest = items.find((x) => x.type === "call" && x.summary);
  const live = (agents.data?.agents || []).filter((a: any) => a.status === "live");
  const allStatuses: string[] = statuses.data?.statuses || Object.keys(STATUS_LABEL);

  return (
    <div>
      <div className="card-roi rounded-2xl p-5 flex flex-wrap items-start gap-4">
        <div className="h-14 w-14 rounded-full bg-white/10 grid place-items-center font-display text-2xl text-ink">{(c.name || "?").slice(0, 1).toUpperCase()}</div>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[28px] leading-tight text-ink">{c.name || "Unnamed"}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-soft">
            <span className="tabular-nums">{c.phone}</span>{c.email && <span>{c.email}</span>}
            <span className="chip bg-white/10 text-ink">{c.stage === "customer" ? "Customer" : "Lead"}</span>
            {can("manager") ? (
              <select className="input h-7 w-auto py-0 text-xs" value={c.status} onChange={(e) => quickStatus.mutate(e.target.value)} aria-label="Status">
                {[...new Set([c.status, ...allStatuses])].map((s) => <option key={s} value={s}>{STATUS_LABEL[s] || s}</option>)}
              </select>
            ) : <ContactStatus status={c.status} />}
            {info.data.dnc && <span className="chip bg-bad-wash text-bad">Do not call</span>}
          </div>
          {!!c.tags?.length && <div className="mt-2 flex flex-wrap gap-1.5">{c.tags.map((t: string) => <span key={t} className="chip bg-white/10 text-ink-soft">#{t}</span>)}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          {can("manager") && <button className="btn-line btn-sm" onClick={() => { setTab("details"); setEditing(true); }}><Pencil className="h-3.5 w-3.5" /> Edit</button>}
          {onClose && <button className="btn-ghost btn-sm" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button>}
        </div>
      </div>

      <div className="flex gap-1 mt-4 border-b border-canvas-line">
        {(["conversation", "details"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 h-10 text-sm -mb-px border-b-2 ${tab === t ? "border-leaf text-ink" : "border-transparent text-ink-mute hover:text-ink"}`}>
            {t === "conversation" ? `Conversation (${conv.data ? conv.data.calls + conv.data.messages : "…"})` : "Details"}
          </button>
        ))}
      </div>

      {tab === "conversation" ? (
        <div className="mt-4 space-y-3">
          {can("manager") && (
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (sms.trim()) send.mutate(); }}>
                <input className="input" placeholder="Write an SMS…" value={sms} onChange={(e) => setSms(e.target.value)} maxLength={600} />
                <button className="btn-primary" disabled={send.isPending || !sms.trim()}><Send className="h-4 w-4" /> Send</button>
              </form>
              <div className="flex gap-2">
                <select className="input w-48" value={callAgent} onChange={(e) => setCallAgent(e.target.value)} aria-label="Agent to call with">
                  <option value="">{live.length ? "Call with agent…" : "No live agent"}</option>
                  {live.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <button className="btn-line" disabled={!callAgent || call.isPending || info.data.dnc} onClick={() => call.mutate(callAgent)}><PhoneCall className="h-4 w-4" /> {call.isPending ? "Calling…" : "Call"}</button>
              </div>
            </div>
          )}
          <ErrorNote error={send.error || call.error} />
          {call.isSuccess && <div className="rounded-xl bg-leaf-wash text-leaf text-sm px-3 py-2">Call started — it appears here when it ends.</div>}
          {conv.isLoading ? <Loading /> : !items.length ? (
            <div className="glass rounded-2xl p-10 text-center"><MessageSquare className="h-10 w-10 text-ink-mute mx-auto mb-3" /><div className="text-ink">No conversations yet</div><div className="text-sm text-ink-mute mt-1">Calls and text messages with this contact appear here.</div></div>
          ) : items.map((it) => it.type === "call" ? <CallItem key={`c${it.id}`} c={it} /> : <SmsItem key={`m${it.id}`} m={it} />)}
        </div>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_340px]">
          <div className="space-y-4">
            {editing ? (
              <div className="card p-5 space-y-3">
                <div className="grid sm:grid-cols-2 gap-3">
                  <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
                  <Field label="Phone"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
                  <Field label="Email"><input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
                  <Field label="Status"><select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{[...new Set([f.status, ...allStatuses])].map((s) => <option key={s} value={s}>{STATUS_LABEL[s] || s}</option>)}</select></Field>
                  <Field label="Type"><select className="input" value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })}><option value="lead">Lead</option><option value="customer">Customer</option></select></Field>
                  <Field label="Tags (comma separated)"><input className="input" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="vip, warranty" /></Field>
                </div>
                <Field label="Notes for the agents"><textarea className="textarea min-h-[110px]" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Gate code, pets, preferred technician…" /></Field>
                <ErrorNote error={save.error} />
                <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setEditing(false)}>Cancel</button><button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save changes"}</button></div>
              </div>
            ) : (
              <div className="card p-5">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div><div className="eyebrow">Status</div><div className="mt-1.5"><ContactStatus status={c.status} /></div></div>
                  <div><div className="eyebrow">Calls</div><div className="num text-3xl mt-1">{conv.data?.calls ?? "…"}</div></div>
                  <div><div className="eyebrow">Messages</div><div className="num text-3xl mt-1">{conv.data?.messages ?? "…"}</div></div>
                  <div><div className="eyebrow">Jobs</div><div className="num text-3xl mt-1">{bookings.length}</div></div>
                </div>
                <div className="mt-5 text-sm text-ink-soft whitespace-pre-wrap">{c.notes || <span className="text-ink-mute">No notes yet.</span>}</div>
                <div className="mt-4 text-xs text-ink-mute">{c.source ? `Source: ${SOURCE_LABEL[c.source] || c.source} · ` : ""}Added {when(c.createdAt, { dateStyle: "medium" })} · updated {ago(c.updatedAt)}{c.statusLocked ? " · status set by a person (calls won't change it)" : ""}</div>
              </div>
            )}
            {latest && (
              <div className="card p-5">
                <h3 className="eyebrow mb-2">Latest call analysis</h3>
                <p className="text-sm text-ink-soft">{latest.summary}</p>
                <div className="mt-2 flex flex-wrap gap-1.5"><OutcomeChip outcome={latest.outcome} />{latest.extraction?.sentiment && <span className="chip bg-white/[0.06] text-ink-soft">Sentiment: {latest.extraction.sentiment}</span>}{latest.recording_available && <span className="chip bg-white/[0.06] text-ink-soft"><Mic className="h-3 w-3" /> recording</span>}</div>
              </div>
            )}
          </div>
          <div className="space-y-4">
            <div className="card p-5">
              <h3 className="eyebrow mb-2">Jobs</h3>
              {bookings.length ? bookings.map((b: any) => <div key={b.id} className="flex justify-between gap-2 py-2 border-t border-canvas-line first:border-0 text-sm"><span>{b.job_type} · {when(b.starts_at)}</span><StatusChip status={b.status} /></div>) : <div className="text-sm text-ink-mute">No jobs booked.</div>}
            </div>
            {leads.length > 0 && <div className="card p-5"><h3 className="eyebrow mb-2">Enquiries</h3>{leads.map((l: any) => <div key={l.id} className="flex justify-between gap-2 py-2 border-t border-canvas-line first:border-0 text-sm"><span>{SOURCE_LABEL[l.source] || l.source} · {l.service || "—"}</span><StatusChip status={l.status} /></div>)}</div>}
            {can("manager") && (
              <div className="card p-5 space-y-2">
                {!info.data.dnc && <button className="btn-line btn-sm w-full" onClick={async () => (await ask({ title: "Do not call this number?", body: "Agents and campaigns will never call or text this number again.", confirmLabel: "Do not call", danger: true })) && dnc.mutate()}><Ban className="h-3.5 w-3.5" /> Do not call</button>}
                <button className="btn-ghost btn-sm w-full text-bad" onClick={async () => (await ask({ title: "Delete this contact?", body: "The contact is removed. Their calls stay in the call log.", confirmLabel: "Delete", danger: true })) && remove.mutate()}><Trash2 className="h-3.5 w-3.5" /> Delete contact</button>
                <ErrorNote error={dnc.error || remove.error} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
