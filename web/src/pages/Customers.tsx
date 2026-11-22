/** Customers — the ClusterOS CRM customer section: table, filters, add, and a contact view with the conversation. */
import { FormEvent, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { get, post } from "../lib/api";
import { ago } from "../lib/format";
import { useSession } from "../lib/session";
import { ContactStatus, ContactView, STATUS_LABEL } from "../components/Contact";
import { Empty, ErrorNote, Field, Loading, Modal, PageHeader } from "../components/ui";

export function ContactList({ stage, title, subtitle }: { stage: "customer" | "lead" | "all"; title: string; subtitle: string }) {
  const { can } = useSession();
  const nav = useNavigate();
  const [s, setS] = useState("");
  const [term, setTerm] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ["customers", stage, term, status], queryFn: () => get(`/customers?limit=200&stage=${stage === "all" ? "" : stage}&status=${status}&q=${encodeURIComponent(term)}`) });
  return (
    <div>
      <PageHeader title={title} subtitle={q.data ? `${subtitle} · ${q.data.counts.customers} customers · ${q.data.counts.leads} leads` : subtitle} actions={
        <>
          <form onSubmit={(e) => { e.preventDefault(); setTerm(s); }} className="relative">
            <Search className="h-4 w-4 absolute left-3 top-3 text-ink-mute" />
            <input className="input pl-9 w-56" placeholder="Name, phone, email, tag" value={s} onChange={(e) => setS(e.target.value)} aria-label="Search" />
          </form>
          <select className="input h-10 w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">All statuses</option>{(q.data?.statuses || []).map((x: string) => <option key={x} value={x}>{STATUS_LABEL[x] || x}</option>)}
          </select>
          {can("manager") && <button className="btn-primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add</button>}
        </>
      } />
      {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : !q.data.customers.length ? <Empty title={term || status ? "No match" : `No ${title.toLowerCase()} yet`} /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead><tr><th className="th">Name</th><th className="th">Phone</th><th className="th">Email</th><th className="th">Status</th><th className="th">Calls</th><th className="th">SMS</th><th className="th">Jobs</th><th className="th">Last activity</th><th className="th">Tags</th></tr></thead>
            <tbody>{q.data.customers.map((c: any) => (
              <tr key={c.id} onClick={() => setOpen(c.id)} className="cursor-pointer hover:bg-white/[0.04]">
                <td className="td"><div className="font-medium text-ink">{c.name || "Unnamed"}</div><div className="text-xs text-ink-mute">{c.stage === "customer" ? "Customer" : "Lead"}{c.source ? ` · ${c.source.replace(/_/g, " ")}` : ""}</div></td>
                <td className="td tabular-nums">{c.phone_e164}</td>
                <td className="td text-ink-soft">{c.email || "—"}</td>
                <td className="td"><ContactStatus status={c.status} /></td>
                <td className="td tabular-nums">{c.calls}</td>
                <td className="td tabular-nums">{c.messages}</td>
                <td className="td tabular-nums">{c.bookings}</td>
                <td className="td text-ink-mute">{ago(c.last_call_at || c.updated_at)}</td>
                <td className="td">{(c.tags || []).slice(0, 3).map((t: string) => <span key={t} className="chip bg-white/[0.06] text-ink-soft mr-1">#{t}</span>)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {open && (
        <Modal open onClose={() => setOpen(null)} title="Contact" wide>
          <ContactView id={open} onDeleted={() => setOpen(null)} />
          <div className="mt-4 text-right"><button className="btn-ghost btn-sm" onClick={() => nav(`/app/customers/${open}`)}>Open full page →</button></div>
        </Modal>
      )}
      <AddContact open={adding} stage={stage === "lead" ? "lead" : "customer"} onClose={() => setAdding(false)} onAdded={(id) => { setAdding(false); setOpen(id); }} />
    </div>
  );
}

function AddContact({ open, stage, onClose, onAdded }: { open: boolean; stage: "lead" | "customer"; onClose: () => void; onAdded: (id: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: "", phone: "", email: "", stage, status: "fresh", notes: "" });
  const m = useMutation({ mutationFn: () => post("/customers", f), onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ["customers"] }); setF({ name: "", phone: "", email: "", stage, status: "fresh", notes: "" }); onAdded(r.customer.id); } });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  return (
    <Modal open={open} onClose={onClose} title="Add contact">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Phone"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required placeholder="+91 98…" /></Field>
          <Field label="Email"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Type"><select className="input" value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value as any })}><option value="customer">Customer</option><option value="lead">Lead</option></select></Field>
        </div>
        <Field label="Notes"><textarea className="textarea" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending}>Add contact</button></div>
      </form>
    </Modal>
  );
}

export default function Customers() {
  return <ContactList stage="customer" title="Customers" subtitle="People who booked a job. Click one for the whole conversation" />;
}

/** Full-page contact (/app/customers/:id). */
export function CustomerPage() {
  const { id } = useParams();
  const nav = useNavigate();
  return <ContactView id={id!} onClose={() => nav(-1)} onDeleted={() => nav("/app/customers")} />;
}
