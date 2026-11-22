/**
 * The agent's knowledge library (Rasen knowledge): website pages, text and documents the agent
 * answers from. Sources ingest in the background; the agent republishes itself when they are ready.
 * Also the agent's published versions with rollback.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileText, Globe, RefreshCw, RotateCcw, Trash2, Type } from "lucide-react";
import { del, get, post } from "../lib/api";
import { ago, when } from "../lib/format";
import { useConfirm } from "./Confirm";
import { ErrorNote, Field, Loading } from "./ui";

const STATE_TONE: Record<string, string> = { ready: "bg-leaf-wash text-leaf", failed: "bg-bad-wash text-bad", pending: "bg-warn-wash text-warn", ingesting: "bg-warn-wash text-warn", archived: "bg-canvas-deep text-ink-mute" };

export function AgentKnowledge({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const ask = useConfirm();
  const kb = useQuery({ queryKey: ["knowledge", agentId], queryFn: () => get(`/agents/${agentId}/knowledge`), refetchInterval: (q) => (q.state.data?.pending ? 8000 : false) });
  const [mode, setMode] = useState<"url" | "text" | "file">("url");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["knowledge", agentId] });
  const add = useMutation({
    mutationFn: async () => {
      if (mode === "url") return post(`/agents/${agentId}/knowledge`, { kind: "url", url: url.trim() });
      if (mode === "text") return post(`/agents/${agentId}/knowledge`, { kind: "text", name: name.trim(), text });
      if (!file) throw new Error("Choose a file.");
      const dataBase64 = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] || ""); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
      return post(`/agents/${agentId}/knowledge/upload`, { name: name.trim() || file.name, filename: file.name, dataBase64 });
    },
    onSuccess: () => { setUrl(""); setName(""); setText(""); setFile(null); refresh(); },
  });
  const remove = useMutation({ mutationFn: (s: any) => del(`/agents/${agentId}/knowledge/${s.id}?relation=${s.relation || ""}`), onSuccess: refresh });
  const again = useMutation({ mutationFn: (s: any) => post(`/agents/${agentId}/knowledge/${s.id}/refresh`), onSuccess: refresh });
  const sources: any[] = kb.data?.sources || [];

  return (
    <div className="card p-5">
      <h2 className="font-semibold flex items-center gap-2"><BookOpen className="h-4 w-4 text-leaf" /> Knowledge</h2>
      <p className="text-xs text-ink-mute mt-1">Your website, price list or FAQ — the agent answers callers from it. New knowledge goes live by itself once it is read (the agent is republished automatically).</p>
      {kb.isLoading ? <Loading /> : kb.error ? <ErrorNote error={kb.error} /> : (
        <div className="mt-3 space-y-2">
          {!sources.length && <div className="text-sm text-ink-mute">Nothing yet — add your website below.</div>}
          {sources.map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-xl well px-3 py-2">
              {s.kind === "url" ? <Globe className="h-4 w-4 text-ink-mute shrink-0" /> : s.kind === "file" ? <FileText className="h-4 w-4 text-ink-mute shrink-0" /> : <Type className="h-4 w-4 text-ink-mute shrink-0" />}
              <div className="min-w-0 flex-1"><div className="text-sm text-ink truncate">{s.name}</div><div className="text-xs text-ink-mute">{s.kind}{s.updatedAt ? ` · ${ago(s.updatedAt)}` : ""}{s.failure ? ` · ${String(s.failure).replace(/_/g, " ")}` : ""}</div></div>
              <span className={`chip ${STATE_TONE[s.state] || "bg-canvas-deep text-ink-soft"}`}>{s.state}</span>
              {canEdit && s.kind === "url" && <button className="btn-ghost btn-sm" title="Read the page again" onClick={() => again.mutate(s)}><RefreshCw className="h-3.5 w-3.5" /></button>}
              {canEdit && <button className="btn-ghost btn-sm text-bad" title="Remove" onClick={async () => (await ask({ title: "Remove this knowledge?", body: `${s.name} stops being used once the agent republishes.`, confirmLabel: "Remove", danger: true })) && remove.mutate(s)}><Trash2 className="h-3.5 w-3.5" /></button>}
            </div>
          ))}
          {kb.data?.pending && <div className="text-xs text-warn">Reading your sources… the agent republishes itself when they are ready.</div>}
        </div>
      )}
      {canEdit && (
        <div className="mt-4 rounded-2xl well p-3 space-y-3">
          <div className="seg w-fit">{(["url", "text", "file"] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "url" ? "Website" : m === "text" ? "Text" : "Document"}</button>)}</div>
          {mode === "url" && <Field label="Web page (https://…)"><input className="input" placeholder="https://yourbusiness.com" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>}
          {mode !== "url" && <Field label="Name"><input className="input" placeholder={mode === "text" ? "Price list" : "Brochure"} value={name} onChange={(e) => setName(e.target.value)} /></Field>}
          {mode === "text" && <Field label="Text"><textarea className="textarea min-h-[120px]" value={text} onChange={(e) => setText(e.target.value)} placeholder="Services, prices, hours, areas, policies…" /></Field>}
          {mode === "file" && <Field label="PDF, DOCX, Markdown or text (up to 20 MB)"><input type="file" accept=".pdf,.docx,.md,.markdown,.txt" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>}
          <ErrorNote error={add.error || remove.error || again.error} />
          <button className="btn-primary btn-sm" disabled={add.isPending || (mode === "url" ? !url.trim() : mode === "text" ? !name.trim() || !text.trim() : !file)} onClick={() => add.mutate()}>{add.isPending ? "Adding…" : "Add knowledge"}</button>
        </div>
      )}
    </div>
  );
}

export function AgentVersions({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const ask = useConfirm();
  const v = useQuery({ queryKey: ["versions", agentId], queryFn: () => get(`/agents/${agentId}/versions`) });
  const roll = useMutation({ mutationFn: (id: string) => post(`/agents/${agentId}/rollback`, { versionId: id }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["versions", agentId] }); qc.invalidateQueries({ queryKey: ["agent", agentId] }); } });
  const rows: any[] = v.data?.versions || [];
  return (
    <div className="card p-5">
      <h2 className="font-semibold mb-2">Published versions</h2>
      {v.isLoading ? <Loading /> : v.error ? <ErrorNote error={v.error} /> : !rows.length ? <div className="text-sm text-ink-mute">Not published yet.</div> : (
        <div className="space-y-1.5 max-h-56 overflow-y-auto">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-2 text-sm">
              <span>v{r.number} · {when(r.createdAt)}</span>
              {r.live ? <span className="chip bg-leaf-wash text-leaf">live</span> : canEdit && <button className="btn-ghost btn-sm" onClick={async () => (await ask({ title: `Put v${r.number} back live?`, body: "New calls use that version. You can switch again any time.", confirmLabel: "Roll back" })) && roll.mutate(r.id)}><RotateCcw className="h-3.5 w-3.5" /> Use this</button>}
            </div>
          ))}
        </div>
      )}
      <ErrorNote error={roll.error} />
    </div>
  );
}
