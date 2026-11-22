import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Plus } from "lucide-react";
import { get, post } from "../lib/api";
import { when } from "../lib/format";
import { useSession } from "../lib/session";
import { Empty, ErrorNote, Field, Loading, Modal, PageHeader, StatusChip } from "../components/ui";

export default function Agents() {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => get("/agents") });
  const playbooks = useQuery({ queryKey: ["playbooks"], queryFn: () => get("/playbooks") });
  return (
    <div>
      <PageHeader title="Agents" subtitle="Each agent is built for this business from one of our playbooks." actions={can("manager") && <button className="btn-primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New agent</button>} />
      {agents.isLoading ? <Loading /> : agents.error ? <ErrorNote error={agents.error} /> : !agents.data.agents.length ? (
        <Empty title="No agents yet" body="Start with an inbound booking agent: it answers your number and books jobs." action={can("manager") && <button className="btn-leaf" onClick={() => setOpen(true)}>Create the first agent</button>} />
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {agents.data.agents.map((a: any) => (
            <Link key={a.id} to={`/app/agents/${a.id}`} className="card p-5 hover:shadow-lift transition-shadow">
              <div className="flex items-start justify-between">
                <div className="h-10 w-10 rounded-xl bg-plum-wash grid place-items-center"><Bot className="h-5 w-5 text-plum" /></div>
                <StatusChip status={a.status} />
              </div>
              <div className="mt-4 font-semibold">{a.name}</div>
              <div className="text-sm text-ink-mute">{playbooks.data?.playbooks?.[a.playbook]?.label || a.playbook}</div>
              <div className="mt-3 text-xs text-ink-mute">{a.publishedAt ? `Published ${when(a.publishedAt)}` : "Not published yet"}</div>
              {a.publishError && <div className="mt-2 text-xs text-bad line-clamp-2">{a.publishError}</div>}
            </Link>
          ))}
        </div>
      )}
      <NewAgent open={open} onClose={() => setOpen(false)} playbooks={playbooks.data?.playbooks || {}} />
    </div>
  );
}

function NewAgent({ open, onClose, playbooks }: { open: boolean; onClose: () => void; playbooks: Record<string, any> }) {
  const [name, setName] = useState("Ava");
  const [playbook, setPlaybook] = useState("inbound_booking");
  const nav = useNavigate();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => post("/agents", { name, playbook }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["agents"] }); onClose(); nav(`/app/agents/${r.agent.id}`); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  return (
    <Modal open={open} onClose={onClose} title="New agent" wide>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name the agent introduces itself with"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} /></Field>
        <div>
          <span className="label">Playbook</span>
          <div className="grid sm:grid-cols-2 gap-2">
            {Object.entries(playbooks).map(([k, p]: any) => (
              <button type="button" key={k} onClick={() => setPlaybook(k)} className={`text-left rounded-xl border p-3 ${playbook === k ? "border-leaf bg-leaf-wash" : "border-canvas-line bg-white/[0.03] hover:bg-canvas-tint"}`}>
                <div className="text-sm font-medium flex items-center justify-between">{p.label}<span className="text-[10px] uppercase tracking-wide text-ink-mute">{p.direction}</span></div>
                <div className="text-xs text-ink-mute mt-0.5">{p.summary}</div>
              </button>
            ))}
          </div>
        </div>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending}>{m.isPending ? "Creating…" : "Create agent"}</button></div>
      </form>
    </Modal>
  );
}
