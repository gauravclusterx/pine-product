/** AI keys + model (OpenAI, Anthropic) — the CRM admin's "AI keys" section. Keys are write-only. */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { get, put } from "../lib/api";
import { ErrorNote, Field, Loading } from "./ui";
import { useConfirm } from "./Confirm";

export function AiKeysForm({ endpoint, note }: { endpoint: string; note?: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["ai-keys", endpoint], queryFn: () => get(endpoint) });
  const [oKey, setOKey] = useState("");
  const [aKey, setAKey] = useState("");
  const [oModel, setOModel] = useState<string | null>(null);
  const [aModel, setAModel] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const ask = useConfirm();
  const save = useMutation({
    mutationFn: (body: any) => put(endpoint, body),
    onSuccess: (d) => { qc.setQueryData(["ai-keys", endpoint], d); setOKey(""); setAKey(""); setSaved(true); setTimeout(() => setSaved(false), 2500); },
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data;
  const body: any = { openaiModel: oModel ?? d.openai.model, anthropicModel: aModel ?? d.anthropic.model };
  if (oKey.trim()) body.openaiKey = oKey.trim();
  if (aKey.trim()) body.anthropicKey = aKey.trim();
  const keyLabel = (name: string, s: any) => `${name} key ${s.set ? `(set · …${s.last4 || ""})` : "(not set)"}`;
  return (
    <div className="space-y-3">
      {note && <p className="text-xs text-ink-mute">{note}</p>}
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label={keyLabel("OpenAI", d.openai)}><input className="input" type="password" autoComplete="off" placeholder={d.openai.set ? "Leave empty to keep" : "sk-…"} value={oKey} onChange={(e) => setOKey(e.target.value)} /></Field>
        <Field label="OpenAI model (pick or type any)">
          <input className="input" list={`om-${endpoint}`} value={oModel ?? d.openai.model} onChange={(e) => setOModel(e.target.value)} />
          <datalist id={`om-${endpoint}`}>{d.models.openai.map((m: string) => <option key={m} value={m} />)}</datalist>
        </Field>
        <Field label={keyLabel("Anthropic", d.anthropic)}><input className="input" type="password" autoComplete="off" placeholder={d.anthropic.set ? "Leave empty to keep" : "sk-ant-…"} value={aKey} onChange={(e) => setAKey(e.target.value)} /></Field>
        <Field label="Anthropic model (pick or type any)">
          <input className="input" list={`am-${endpoint}`} value={aModel ?? d.anthropic.model} onChange={(e) => setAModel(e.target.value)} />
          <datalist id={`am-${endpoint}`}>{d.models.anthropic.map((m: string) => <option key={m} value={m} />)}</datalist>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate(body)}><KeyRound className="h-3.5 w-3.5" /> {save.isPending ? "Checking key…" : "Save AI keys"}</button>
        {d.openai.set && <button className="btn-ghost btn-sm" onClick={async () => (await ask({ title: "Remove the OpenAI key?", body: "AI features fall back to the next key that is set.", confirmLabel: "Remove", danger: true })) && save.mutate({ openaiKey: "" })}>Remove OpenAI key</button>}
        {d.anthropic.set && <button className="btn-ghost btn-sm" onClick={async () => (await ask({ title: "Remove the Anthropic key?", body: "AI features fall back to the next key that is set.", confirmLabel: "Remove", danger: true })) && save.mutate({ anthropicKey: "" })}>Remove Anthropic key</button>}
        {saved && <span className="text-xs text-leaf">Saved ✓</span>}
        {d.serverKey && <span className="text-xs text-ink-mute">A server OpenAI key is also set (used last).</span>}
        {d.usesPlatform && <span className="text-xs text-ink-mute">No own key — uses the platform keys.</span>}
      </div>
      <ErrorNote error={save.error} />
    </div>
  );
}
