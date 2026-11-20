import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban } from "lucide-react";
import { get, patch, post } from "../lib/api";
import { duration, SOURCE_LABEL, when } from "../lib/format";
import { useSession } from "../lib/session";
import { ErrorNote, Field, Loading, OutcomeChip, PageHeader, StatusChip } from "../components/ui";

export default function CustomerDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["customer", id], queryFn: () => get(`/customers/${id}`) });
  const [f, setF] = useState({ name: "", email: "", notes: "" });
  useEffect(() => { if (q.data) setF({ name: q.data.customer.name, email: q.data.customer.email, notes: q.data.customer.notes }); }, [q.data]);
  const save = useMutation({ mutationFn: () => patch(`/customers/${id}`, f), onSuccess: () => qc.invalidateQueries({ queryKey: ["customer", id] }) });
  const dnc = useMutation({ mutationFn: () => post("/dnc", { phone: q.data.customer.phone, reason: "customer_request" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["customer", id] }) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const { customer: c, calls, bookings, leads } = q.data;
  return (
    <div>
      <Link to="/app/customers" className="inline-flex items-center gap-1 text-sm text-ink-mute hover:text-ink mb-3"><ArrowLeft className="h-4 w-4" /> Customers</Link>
      <PageHeader title={c.name || c.phone} subtitle={<>{c.phone}{c.email ? ` · ${c.email}` : ""}{q.data.dnc && <span className="ml-2 chip bg-bad-wash text-bad">Do not call</span>}</>}
        actions={can("manager") && !q.data.dnc && <button className="btn-line" onClick={() => { if (confirm("Never call this number again?")) dnc.mutate(); }}><Ban className="h-4 w-4" /> Do not call</button>} />
      <div className="grid lg:grid-cols-[1fr_360px] gap-4">
        <div className="space-y-4">
          <div className="card p-5">
            <h2 className="font-semibold mb-3">Calls</h2>
            {calls.length ? calls.map((x: any) => (
              <Link key={x.id} to={`/app/calls/${x.id}`} className="flex items-start justify-between gap-3 py-3 border-t border-canvas-line first:border-0 hover:text-plum">
                <div className="min-w-0"><div className="text-sm">{when(x.started_at)} · {x.direction} · {duration(x.duration_seconds)}</div><div className="text-xs text-ink-mute line-clamp-2">{x.summary || "—"}</div></div>
                <OutcomeChip outcome={x.outcome} />
              </Link>
            )) : <div className="text-sm text-ink-mute">No calls yet.</div>}
          </div>
          <div className="card p-5">
            <h2 className="font-semibold mb-3">Jobs</h2>
            {bookings.length ? bookings.map((b: any) => (
              <div key={b.id} className="flex justify-between py-2 border-t border-canvas-line first:border-0 text-sm"><span>{b.job_type} · {when(b.starts_at)}</span><StatusChip status={b.status} /></div>
            )) : <div className="text-sm text-ink-mute">No jobs booked.</div>}
          </div>
          {leads.length > 0 && (
            <div className="card p-5"><h2 className="font-semibold mb-3">Enquiries</h2>
              {leads.map((l: any) => <div key={l.id} className="flex justify-between py-2 border-t border-canvas-line first:border-0 text-sm"><span>{SOURCE_LABEL[l.source] || l.source} · {l.service || "—"} · {when(l.received_at)}</span><StatusChip status={l.status} /></div>)}
            </div>
          )}
        </div>
        <div className="card p-5 space-y-3 h-fit">
          <h2 className="font-semibold">On file</h2>
          <p className="text-xs text-ink-mute">Agents greet this customer with the name on file and see these notes and the call history on every call.</p>
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={!can("manager")} /></Field>
          <Field label="Email"><input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} disabled={!can("manager")} /></Field>
          <Field label="Notes for the agents"><textarea className="textarea min-h-[100px]" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} disabled={!can("manager")} placeholder="Gate code, pets, preferred technician…" /></Field>
          <div className="text-xs text-ink-mute">{c.consentAt ? `Consent to call: ${when(c.consentAt, { dateStyle: "medium" })} (${c.consentSource})` : "No consent to automated calls on record."}</div>
          <ErrorNote error={save.error || dnc.error} />
          {can("manager") && <button className="btn-primary w-full" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</button>}
        </div>
      </div>
    </div>
  );
}
