import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Pause, Rocket, Save, Trash2 } from "lucide-react";
import { del, get, patch, post } from "../lib/api";
import { when } from "../lib/format";
import { useSession } from "../lib/session";
import { ErrorNote, Field, Loading, PageHeader, StatusChip } from "../components/ui";
import { useConfirm } from "../components/Confirm";
import { AgentKnowledge, AgentVersions } from "../components/AgentKnowledge";

const ALL_TOOLS: Record<string, string> = {
  lookup_customer: "Look up the caller (before the call)", get_availability: "Check open windows", book_job: "Book the job", reschedule_job: "Reschedule",
  cancel_job: "Cancel", create_lead: "Save a lead / callback", get_estimates: "Read open estimates", get_membership: "Read membership", send_sms: "Text the customer", notify_team: "Alert the team",
};

/** "Hi, this is Ava…" → "Hi {{greeting_name}}, this is Ava…". */
function addName(greeting: string): string {
  const s = String(greeting || "").trim();
  const m = /^(hi|hello|hey|namaste)\b[\s.,!]*/i.exec(s);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} {{greeting_name}}, ${s.slice(m[0].length)}`.trim();
  return `Hi {{greeting_name}}! ${s}`.trim();
}

export default function AgentEditor() {
  const ask = useConfirm();
  const { id } = useParams();
  const { can } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["agent", id], queryFn: () => get(`/agents/${id}`) });
  const voices = useQuery({ queryKey: ["voices"], queryFn: () => get("/voice/voices"), retry: false });
  const [form, setForm] = useState<any>(null);
  const [name, setName] = useState("");
  const [testLink, setTestLink] = useState<string | null>(null);
  useEffect(() => { if (q.data) { setForm({ ...q.data.agent.config, tools: q.data.tools }); setName(q.data.agent.name); } }, [q.data]);

  const save = useMutation({ mutationFn: () => patch(`/agents/${id}`, { name, config: form }), onSuccess: () => qc.invalidateQueries({ queryKey: ["agent", id] }) });
  const publish = useMutation({ mutationFn: async () => { await patch(`/agents/${id}`, { name, config: form }); return post(`/agents/${id}/publish`); }, onSuccess: () => { qc.invalidateQueries({ queryKey: ["agent", id] }); qc.invalidateQueries({ queryKey: ["agents"] }); } });
  const pause = useMutation({ mutationFn: () => post(`/agents/${id}/pause`), onSuccess: () => qc.invalidateQueries({ queryKey: ["agent", id] }) });
  const archive = useMutation({ mutationFn: () => del(`/agents/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["agents"] }); nav("/app/agents"); } });
  const test = useMutation({ mutationFn: () => post(`/agents/${id}/test-link`), onSuccess: (r: any) => setTestLink(r.token || null) });

  if (q.isLoading || !form) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const a = q.data.agent;
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const editable = can("manager");
  return (
    <div>
      <PageHeader
        title={a.name}
        subtitle={<span className="inline-flex items-center gap-2"><StatusChip status={a.status} />{a.publishedAt ? `Live version from ${when(a.publishedAt)}` : "Draft — not answering calls yet"}</span>}
        actions={editable && (
          <>
            <button className="btn-line" onClick={() => test.mutate()} disabled={test.isPending || a.status !== "live"} title={a.status !== "live" ? "Publish first" : "Talk to the agent in your browser"}><ExternalLink className="h-4 w-4" /> Test call</button>
            <button className="btn-line" onClick={() => save.mutate()} disabled={save.isPending}><Save className="h-4 w-4" /> {save.isPending ? "Saving…" : "Save draft"}</button>
            <button className="btn-leaf" onClick={() => publish.mutate()} disabled={publish.isPending}><Rocket className="h-4 w-4" /> {publish.isPending ? "Publishing…" : "Publish"}</button>
          </>
        )}
      />
      <div className="space-y-3 mb-4">
        <ErrorNote error={save.error || publish.error || pause.error || archive.error || test.error} />
        {a.publishError && <div className="rounded-xl bg-bad-wash text-bad text-sm px-3 py-2">Last publish failed: {a.publishError}</div>}
        {publish.isSuccess && <div className="rounded-xl bg-leaf-wash text-leaf-dark text-sm px-3 py-2">Published. New calls use this version.</div>}
        {testLink && <div className="rounded-xl bg-plum-wash text-plum text-sm px-3 py-2">Test-call token (expires soon) — open the agent's hosted test page at the voice provider and paste it: <code className="break-all font-mono text-xs">{testLink}</code></div>}
      </div>
      <div className="grid lg:grid-cols-[1fr_380px] gap-4">
        <div className="space-y-4">
          <div className="card p-5 space-y-4">
            <h2 className="font-semibold">Conversation</h2>
            <Field label="Agent name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} /></Field>
            <Field label="Greeting" hint={<>Leave empty for the playbook's greeting. Write <code>{"{{greeting_name}}"}</code> where the customer's first name goes ("there" when unknown).{" "}
              {editable && !(form.greeting || "").includes("{{greeting_name}}") && <button type="button" className="underline text-plum" onClick={() => set("greeting", addName(form.greeting || q.data.preview.firstMessage))}>Add the customer's name</button>}</>}><input className="input" value={form.greeting || ""} onChange={(e) => set("greeting", e.target.value)} placeholder={q.data.preview.firstMessage} disabled={!editable} /></Field>
            <Field label="Client brief" hint="What is special about this business: specials, policies, who handles what, words to use or avoid.">
              <textarea className="textarea min-h-[160px]" value={form.brief} onChange={(e) => set("brief", e.target.value)} disabled={!editable} placeholder="e.g. We charge a $79 diagnostic fee, waived if the repair is done. Never book roof inspections on rainy days." />
            </Field>
            <details className="rounded-xl border border-canvas-line p-3">
              <summary className="text-sm font-medium cursor-pointer">Advanced: write the whole prompt yourself</summary>
              <textarea className="textarea min-h-[200px] mt-3 font-mono text-xs" value={form.promptOverride} onChange={(e) => set("promptOverride", e.target.value)} disabled={!editable} placeholder="Empty = generated from the playbook, the brief and the business settings." />
            </details>
          </div>
          <div className="card p-5">
            <h2 className="font-semibold mb-3">Prompt the agent runs with</h2>
            <pre className="whitespace-pre-wrap text-xs bg-canvas-tint rounded-xl p-4 max-h-[420px] overflow-y-auto border border-canvas-line">{q.data.preview.systemPrompt}</pre>
            <p className="text-xs text-ink-mute mt-2">On every call the platform adds this customer's name on file, profile and history, so the agent never asks for what you already know.</p>
          </div>
          {a.providerAgentId && <AgentKnowledge agentId={a.id} canEdit={can("manager")} />}
        </div>
        <div className="space-y-4">
          <div className="card p-5 space-y-4">
            <h2 className="font-semibold">Voice & limits</h2>
            <Field label="Voice">
              <select className="input" value={form.voiceId || ""} onChange={(e) => set("voiceId", e.target.value || null)} disabled={!editable}>
                <option value="">Workspace default</option>
                {(voices.data?.voices || []).filter((v: any) => v.available).map((v: any) => <option key={v.id} value={v.id}>{v.name}{v.gender ? ` · ${v.gender}` : ""}</option>)}
              </select>
            </Field>
            <Field label="Language">
              <select className="input" value={form.language} onChange={(e) => set("language", e.target.value)} disabled={!editable}>
                <option value="en">English</option><option value="hinglish">Multilingual (English / Hindi)</option><option value="hi">Hindi</option>
              </select>
            </Field>
            <Field label="Longest call (minutes)"><input className="input" type="number" min={1} max={60} value={form.maxCallMinutes} onChange={(e) => set("maxCallMinutes", Number(e.target.value))} disabled={!editable} /></Field>
            <Field label="Transfer to a person" hint="Empty = the business's transfer number from Settings."><input className="input" value={form.transferNumber} onChange={(e) => set("transferNumber", e.target.value)} placeholder="(212) 555-0100" disabled={!editable} /></Field>
            <Field label="On voicemail">
              <select className="input" value={form.voicemail} onChange={(e) => set("voicemail", e.target.value)} disabled={!editable}><option value="leave_message">Leave a message</option><option value="hang_up">Hang up</option></select>
            </Field>
            {form.voicemail === "leave_message" && <Field label="Voicemail message"><textarea className="textarea" value={form.voicemailMessage} onChange={(e) => set("voicemailMessage", e.target.value)} disabled={!editable} placeholder="Empty = a short default message." /></Field>}
          </div>
          {a.providerAgentId && <AgentVersions agentId={a.id} canEdit={can("manager")} />}
          <div className="card p-5">
            <h2 className="font-semibold mb-1">Tools</h2>
            <p className="text-xs text-ink-mute mb-3">What the agent may do in your systems during a call.</p>
            <div className="space-y-2">
              {Object.entries(ALL_TOOLS).map(([k, label]) => {
                const on = form.tools.includes(k);
                const blocked = k === "lookup_customer" && q.data.preview.callDirection === "outbound";
                return (
                  <label key={k} className={`flex items-center gap-2 text-sm ${blocked ? "opacity-40" : ""}`}>
                    <input type="checkbox" className="accent-leaf h-4 w-4" checked={on && !blocked} disabled={!editable || blocked}
                      onChange={() => set("tools", on ? form.tools.filter((t: string) => t !== k) : [...form.tools, k])} />
                    {label}
                  </label>
                );
              })}
            </div>
          </div>
          {editable && (
            <div className="card p-5 space-y-2">
              <h2 className="font-semibold">Danger zone</h2>
              <button className="btn-line w-full" onClick={() => pause.mutate()} disabled={pause.isPending || a.status !== "live"}><Pause className="h-4 w-4" /> Pause (stop answering)</button>
              {can("owner") && <button className="btn-line w-full text-bad" onClick={async () => { if (await ask({ title: `Archive ${a.name}?`, body: "The agent stops taking and making calls.", confirmLabel: "Archive", danger: true })) archive.mutate(); }}><Trash2 className="h-4 w-4" /> Archive agent</button>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
