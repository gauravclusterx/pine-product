import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { del, get, patch, post } from "../lib/api";
import { ContactView } from "../components/Contact";
import { SOURCE_LABEL, when } from "../lib/format";
import { useSession } from "../lib/session";
import { Empty, ErrorNote, Field, Loading, Modal, PageHeader, StatusChip, Toggle } from "../components/ui";

export default function Leads() {
  const { can } = useSession();
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [contact, setContact] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["leads", status], queryFn: () => get(`/leads?limit=100${status ? `&status=${status}` : ""}`), refetchInterval: 15_000 });
  return (
    <div>
      <PageHeader title="Leads" subtitle="Every enquiry from every source and how fast it was called. Click a lead to edit it." actions={
        <>
          <select className="input h-9 w-36" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">All</option>{["new", "queued", "calling", "contacted", "booked", "lost", "rejected"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {can("manager") && <button className="btn-primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add lead</button>}
        </>
      } />
      {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : !q.data.leads.length ? <Empty title="No leads yet" body="Connect Google LSA, Meta, Angi, Thumbtack, Yelp or your website form in Integrations." /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead><tr><th className="th">Received</th><th className="th">Lead</th><th className="th">Source</th><th className="th">Service</th><th className="th">Status</th><th className="th">Called after</th></tr></thead>
            <tbody>{q.data.leads.map((l: any) => (
              <tr key={l.id} onClick={() => setEdit(l)} className="cursor-pointer hover:bg-white/[0.04]">
                <td className="td whitespace-nowrap">{when(l.received_at)}</td>
                <td className="td"><div className="font-medium">{l.name || "—"}</div><div className="text-xs text-ink-mute">{l.phone_e164}</div></td>
                <td className="td">{SOURCE_LABEL[l.source] || l.source}</td>
                <td className="td text-ink-soft">{l.service || "—"}{l.postal_code ? ` · ${l.postal_code}` : ""}</td>
                <td className="td"><StatusChip status={l.status} />{l.reject_reason && <div className="text-xs text-ink-mute mt-1">{l.reject_reason}</div>}</td>
                <td className="td tabular-nums">{l.seconds_to_call == null ? "—" : <span className={l.seconds_to_call <= 60 ? "text-leaf-dark font-medium" : ""}>{l.seconds_to_call < 120 ? `${l.seconds_to_call}s` : `${Math.round(l.seconds_to_call / 60)} min`}</span>}{l.attempts > 1 ? ` · ${l.attempts} tries` : ""}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <AddLead open={open} onClose={() => setOpen(false)} />
      {edit && <EditLead lead={edit} onClose={() => setEdit(null)} onContact={(id) => { setEdit(null); setContact(id); }} />}
      {contact && <Modal open onClose={() => setContact(null)} title="Contact" wide><ContactView id={contact} onDeleted={() => setContact(null)} /></Modal>}
    </div>
  );
}

function AddLead({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: "", phone: "", service: "", postalCode: "", message: "", consent: false });
  const m = useMutation({ mutationFn: () => post("/leads", f), onSuccess: () => { qc.invalidateQueries({ queryKey: ["leads"] }); onClose(); } });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="Add a lead">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name"><input className="input" value={f.name} onChange={set("name")} /></Field>
          <Field label="Phone"><input className="input" value={f.phone} onChange={set("phone")} required /></Field>
          <Field label="Service"><input className="input" value={f.service} onChange={set("service")} /></Field>
          <Field label="Postal code"><input className="input" value={f.postalCode} onChange={set("postalCode")} /></Field>
        </div>
        <Field label="Notes"><textarea className="textarea" value={f.message} onChange={set("message")} /></Field>
        <Toggle checked={f.consent} onChange={(v) => setF({ ...f, consent: v })} label="The person agreed to be called" />
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending}>Save lead</button></div>
      </form>
    </Modal>
  );
}

function EditLead({ lead, onClose, onContact }: { lead: any; onClose: () => void; onContact: (id: string) => void }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const [f, setF] = useState({ name: lead.name || "", phone: lead.phone_e164 || "", email: lead.email || "", service: lead.service || "", postalCode: lead.postal_code || "", message: lead.message || "", status: lead.status });
  const done = () => { qc.invalidateQueries({ queryKey: ["leads"] }); qc.invalidateQueries({ queryKey: ["customers"] }); onClose(); };
  const save = useMutation({ mutationFn: () => patch(`/leads/${lead.id}`, f), onSuccess: done });
  const remove = useMutation({ mutationFn: () => del(`/leads/${lead.id}`), onSuccess: done });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const ro = !can("manager");
  return (
    <Modal open onClose={onClose} title="Lead">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-3">
        <div className="text-xs text-ink-mute">{SOURCE_LABEL[lead.source] || lead.source} · received {when(lead.received_at)}{lead.reject_reason ? ` · ${lead.reject_reason}` : ""}</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name"><input className="input" value={f.name} onChange={set("name")} disabled={ro} /></Field>
          <Field label="Phone"><input className="input" value={f.phone} onChange={set("phone")} disabled={ro} /></Field>
          <Field label="Email"><input className="input" value={f.email} onChange={set("email")} disabled={ro} /></Field>
          <Field label="Status"><select className="input" value={f.status} onChange={set("status")} disabled={ro}>{["new", "queued", "calling", "contacted", "booked", "lost", "rejected"].map((x) => <option key={x} value={x}>{x}</option>)}</select></Field>
          <Field label="Service"><input className="input" value={f.service} onChange={set("service")} disabled={ro} /></Field>
          <Field label="Postal code"><input className="input" value={f.postalCode} onChange={set("postalCode")} disabled={ro} /></Field>
        </div>
        <Field label="Message / notes"><textarea className="textarea" value={f.message} onChange={set("message")} disabled={ro} /></Field>
        <ErrorNote error={save.error || remove.error} />
        <div className="flex flex-wrap justify-between gap-2">
          <div className="flex gap-2">
            {lead.customer_id && <button type="button" className="btn-line btn-sm" onClick={() => onContact(lead.customer_id)}>Open conversation</button>}
            {!ro && <button type="button" className="btn-ghost btn-sm text-bad" onClick={() => confirm("Delete this lead?") && remove.mutate()}>Delete</button>}
          </div>
          {!ro && <div className="flex gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={save.isPending}>Save</button></div>}
        </div>
      </form>
    </Modal>
  );
}
