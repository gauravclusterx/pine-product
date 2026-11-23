/**
 * Knowledge — the business's knowledge library (Rasen workspace sources): websites, text and
 * documents, each used by the agents you pick. Agents republish by themselves when new knowledge
 * is ready, so callers get answers from it right away.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, FileText, Globe, RefreshCw, Trash2, Type } from "lucide-react";
import { del, get, post, put } from "../lib/api";
import { ago } from "../lib/format";
import { useSession } from "../lib/session";
import { useConfirm } from "../components/Confirm";
import { Empty, ErrorNote, Field, Loading, Modal, PageHeader } from "../components/ui";

const FAILURE: Record<string, string> = {
  knowledge_embedding_unavailable: "The voice provider could not process it just now (its knowledge service was unavailable). Press Retry.",
  outbound_destination_refused: "This address is not reachable from the internet (private or blocked). Use a public https page.",
};
const TONE: Record<string, string> = { ready: "bg-leaf-wash text-leaf", failed: "bg-bad-wash text-bad", pending: "bg-warn-wash text-warn", ingesting: "bg-warn-wash text-warn" };
const fileToBase64 = (file: File) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] || ""); r.onerror = () => reject(r.error); r.readAsDataURL(file); });

function AgentChecks({ agents, value, onChange }: { agents: any[]; value: string[]; onChange: (v: string[]) => void }) {
  if (!agents.length) return <div className="text-xs text-ink-mute">No agents yet — <Link className="text-leaf underline" to="/app/agents">create one</Link>.</div>;
  return (
    <div className="flex flex-wrap gap-2">
      {agents.map((a) => (
        <label key={a.id} className={`chip h-8 px-3 cursor-pointer ${value.includes(a.id) ? "bg-leaf-wash text-leaf shadow-glow" : "bg-white/[0.06] text-ink-soft"}`}>
          <input type="checkbox" className="hidden" checked={value.includes(a.id)} onChange={() => onChange(value.includes(a.id) ? value.filter((x) => x !== a.id) : [...value, a.id])} />
          <Bot className="h-3.5 w-3.5" /> {a.name}
        </label>
      ))}
    </div>
  );
}

export default function Knowledge() {
  const { can } = useSession();
  const qc = useQueryClient();
  const ask = useConfirm();
  const kb = useQuery({ queryKey: ["workspace-knowledge"], queryFn: () => get("/knowledge"), refetchInterval: (q) => (q.state.data?.pending ? 8000 : false) });
  const used = useQuery({ queryKey: ["workspace-knowledge", "usage"], queryFn: () => get("/knowledge?usage=1"), enabled: kb.isSuccess, staleTime: 30_000 });
  const usedBy = new Map<string, any[]>((used.data?.sources || []).map((s: any) => [s.id, s.agents || []]));
  const [mode, setMode] = useState<"url" | "text" | "file">("url");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [useIn, setUseIn] = useState<string[]>([]);
  const [editing, setEditing] = useState<any>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["workspace-knowledge"] });
  const add = useMutation({
    mutationFn: async () => {
      if (mode === "url") return post("/knowledge", { kind: "url", url: url.trim(), agentIds: useIn });
      if (mode === "text") return post("/knowledge", { kind: "text", name: name.trim(), text, agentIds: useIn });
      if (!file) throw new Error("Choose a file.");
      return post("/knowledge/upload", { name: name.trim() || file.name, filename: file.name, dataBase64: await fileToBase64(file), agentIds: useIn });
    },
    onSuccess: () => { setUrl(""); setName(""); setText(""); setFile(null); refresh(); },
  });
  const again = useMutation({ mutationFn: (id: string) => post(`/knowledge/${id}/refresh`), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/knowledge/${id}`),
    // Gone from the list at once; the server archives it at the provider and detaches it in the background.
    onMutate: (id: string) => qc.setQueryData(["workspace-knowledge"], (d: any) => d ? { ...d, sources: d.sources.filter((x: any) => x.id !== id) } : d),
    onSettled: refresh,
  });
  const agents: any[] = kb.data?.agents || [];
  const agentsLoading = kb.isLoading;
  const sources: any[] = kb.data?.sources || [];
  const ready = (agents.length && !useIn.length) ? agents.map((a) => a.id) : useIn;

  return (
    <div>
      <PageHeader title="Knowledge" subtitle="Your website, price lists and FAQs. The agents you choose answer callers from them — new knowledge goes live by itself once it is read." />
      {can("manager") && (
        <div className="card p-5">
          <div className="seg w-fit mb-4">{(["url", "text", "file"] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "url" ? "Website" : m === "text" ? "Text" : "Document"}</button>)}</div>
          <div className="grid gap-3">
            {mode === "url" && <Field label="Web page (https://…)"><input className="input" placeholder="https://yourbusiness.com" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>}
            {mode !== "url" && <Field label="Name"><input className="input" placeholder={mode === "text" ? "Price list" : "Brochure"} value={name} onChange={(e) => setName(e.target.value)} /></Field>}
            {mode === "text" && <Field label="Text"><textarea className="textarea min-h-[120px]" value={text} onChange={(e) => setText(e.target.value)} placeholder="Services, prices, hours, areas, policies…" /></Field>}
            {mode === "file" && <Field label="PDF, DOCX, Markdown or text (up to 20 MB)"><input type="file" accept=".pdf,.docx,.md,.markdown,.txt" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>}
            <div><span className="label">Use it in these agents</span>{agentsLoading ? <div className="text-xs text-ink-mute">Loading agents…</div> : <AgentChecks agents={agents} value={ready} onChange={setUseIn} />}</div>
          </div>
          <ErrorNote error={add.error} />
          <button className="btn-primary mt-4" disabled={add.isPending || (mode === "url" ? !url.trim() : mode === "text" ? !name.trim() || !text.trim() : !file)} onClick={() => add.mutate()}>{add.isPending ? "Adding…" : "Add knowledge"}</button>
        </div>
      )}

      <div className="mt-6">
        {kb.isLoading ? <Loading /> : kb.error ? <ErrorNote error={kb.error} /> : !sources.length ? <Empty title="No knowledge yet" body="Add your website above — the agent reads it and answers callers from it." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead><tr><th className="th">Source</th><th className="th">State</th><th className="th">Used by</th><th className="th">Updated</th><th className="th"></th></tr></thead>
              <tbody>{sources.map((s) => (
                <tr key={s.id}>
                  <td className="td"><div className="flex items-center gap-2 text-ink">{s.kind === "url" ? <Globe className="h-4 w-4 text-ink-mute" /> : s.kind === "file" ? <FileText className="h-4 w-4 text-ink-mute" /> : <Type className="h-4 w-4 text-ink-mute" />}<span className="truncate max-w-[320px]">{s.name}</span></div>{!s.fromPine && <div className="text-[11px] text-warn mt-0.5">From your Rasen workspace (not added here)</div>}{s.state === "failed" && <div className="text-xs text-bad mt-1">{FAILURE[s.failure] || `Could not read it (${String(s.failure || "unknown").replace(/_/g, " ")})`}</div>}</td>
                  <td className="td"><span className={`chip ${TONE[s.state] || "bg-canvas-deep text-ink-soft"}`}>{s.state}</span></td>
                  <td className="td">{!usedBy.has(s.id) ? <span className="text-xs text-ink-mute">{used.isLoading ? "checking…" : "—"}</span> : usedBy.get(s.id)!.length ? usedBy.get(s.id)!.map((a: any) => <span key={a.id} className="chip bg-white/[0.06] text-ink-soft mr-1">{a.name}</span>) : <span className="text-xs text-ink-mute">no agent</span>}</td>
                  <td className="td text-ink-mute">{s.updatedAt ? ago(s.updatedAt) : "—"}</td>
                  <td className="td text-right whitespace-nowrap">{can("manager") && (<>
                    <button className="btn-line btn-sm" onClick={() => setEditing({ ...s, agents: usedBy.get(s.id) || [] })}>Agents</button>
                    {(s.kind === "url" || s.state === "failed") && <button className="btn-ghost btn-sm" title="Read it again" onClick={() => again.mutate(s.id)}><RefreshCw className="h-3.5 w-3.5" />{s.state === "failed" ? " Retry" : ""}</button>}
                    <button className="btn-ghost btn-sm text-bad" title="Remove" onClick={async () => (await ask({ title: "Remove this knowledge?", body: s.fromPine ? `${s.name} is deleted: archived at the voice provider, taken out of every agent that uses it, and those agents republish.` : `${s.name} was not added from Pine — it belongs to your Rasen workspace and other systems (like your CRM's agents) may use it. Removing it takes it out of every agent everywhere.`, confirmLabel: "Remove everywhere", danger: true })) && remove.mutate(s.id)}><Trash2 className="h-3.5 w-3.5" /></button>
                  </>)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {kb.data?.pending && <div className="text-xs text-warn mt-2">Reading your sources… agents republish by themselves when they are ready.</div>}
        <ErrorNote error={again.error || remove.error} />
      </div>
      {editing && <UseIn source={editing} agents={agents} onClose={() => { setEditing(null); refresh(); }} />}
    </div>
  );
}

function UseIn({ source, agents, onClose }: { source: any; agents: any[]; onClose: () => void }) {
  const [ids, setIds] = useState<string[]>(source.agents.map((a: any) => a.id));
  const save = useMutation({ mutationFn: () => put(`/knowledge/${source.id}/agents`, { agentIds: ids }), onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title="Agents that use this">
      <p className="text-sm text-ink-soft mb-3">{source.name}</p>
      <AgentChecks agents={agents} value={ids} onChange={setIds} />
      <ErrorNote error={save.error} />
      <div className="flex justify-end gap-2 mt-5"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save"}</button></div>
    </Modal>
  );
}
