import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, KeyRound } from "lucide-react";
import { del, get, post, put } from "../lib/api";
import { ago } from "../lib/format";
import { useSession } from "../lib/session";
import { ErrorNote, Field, Loading, Modal, PageHeader, StatusChip } from "../components/ui";

const GROUPS: Record<string, string> = { schedule: "Dispatch, schedule & CRM", leads: "Lead sources", messaging: "Messaging", alerts: "Team alerts" };

/** What each schedule connector does for the agent — dispatch is where the job lands. */
const DOES: Record<string, { line: string; chips: string[] }> = {
  native: { line: "Built-in dispatch board and calendar — no other software needed.", chips: ["Dispatch board", "Slots"] },
  servicetitan: { line: "Books onto your ServiceTitan dispatch board, following Capacity Planning (technicians and arrival windows).", chips: ["Dispatch board", "Capacity planning", "Customers", "Memberships"] },
  housecall_pro: { line: "Creates the job on your Housecall Pro schedule for dispatch to a technician.", chips: ["Dispatch / schedule", "Customers"] },
  jobber: { line: "Creates the visit in Jobber so it shows on your schedule for dispatch.", chips: ["Dispatch / schedule", "Clients"] },
  salesforce: { line: "Saves the caller as a lead or contact and logs the call.", chips: ["Leads", "Contacts"] },
  acculynx: { line: "Creates the lead and the inspection appointment in AccuLynx.", chips: ["Jobs", "Appointments"] },
  generic_rest: { line: "Sends bookings to your own system over a signed HTTPS endpoint.", chips: ["Any system"] },
  google_calendar: { line: "Books into a Google Calendar.", chips: ["Calendar"] },
  outlook: { line: "Books into an Outlook / Microsoft 365 calendar.", chips: ["Calendar"] },
};

export default function Integrations() {
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: () => get("/integrations/catalog") });
  const mine = useQuery({ queryKey: ["integrations"], queryFn: () => get("/integrations") });
  const org = useQuery({ queryKey: ["org"], queryFn: () => get("/org") });
  const [open, setOpen] = useState<any>(null);
  if (catalog.isLoading || mine.isLoading) return <Loading />;
  if (catalog.error || mine.error) return <ErrorNote error={catalog.error || mine.error} />;
  const byKind = new Map(mine.data.integrations.map((i: any) => [i.kind, i]));
  const crm = org.data?.org?.settings?.crm;
  return (
    <div>
      <PageHeader title="Integrations" subtitle="Agents never touch your software directly — the Integration Hub does, with one connector per system." />
      {Object.entries(GROUPS).map(([g, label]) => (
        <div key={g} className="mb-8">
          <h2 className="text-sm font-semibold text-ink-soft mb-3">{label}</h2>
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
            {catalog.data.catalog.filter((c: any) => c.group === g).map((c: any) => {
              const row: any = byKind.get(c.kind);
              const active = c.kind === "native" ? crm === "native" : !!row;
              return (
                <button key={c.kind} onClick={() => setOpen(c)} className="card p-4 text-left hover:shadow-lift transition-shadow">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium">{c.label}</div>
                    {active ? <StatusChip status={row?.status || "connected"} /> : <span className="chip bg-canvas-deep text-ink-mute">not connected</span>}
                  </div>
                  {DOES[c.kind] && <div className="text-xs text-ink-mute mt-1.5 leading-relaxed">{DOES[c.kind].line}</div>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {DOES[c.kind]?.chips.map((x) => <span key={x} className="chip bg-white/[0.06] text-ink-soft">{x}</span>)}
                    {c.maturity === "unverified" && <span className="chip bg-warn-wash text-warn" title="Built against the vendor's published API and covered by tests; not yet run against a live account.">not live-tested yet</span>}
                    {g === "schedule" && crm === c.kind && <span className="chip bg-leaf-wash text-leaf-dark"><CheckCircle2 className="h-3 w-3" /> schedule system</span>}
                  </div>
                  {row?.lastError && <div className="text-xs text-bad mt-2 line-clamp-2">{row.lastError}</div>}
                  {row?.lastSyncAt && <div className="text-xs text-ink-mute mt-2">Last OK {ago(row.lastSyncAt)}</div>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {open && <Connect spec={open} row={byKind.get(open.kind)} endpoint={mine.data.endpoints[open.kind]} isCrm={crm === open.kind} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Connect({ spec, row, endpoint, isCrm, onClose }: { spec: any; row: any; endpoint?: string; isCrm: boolean; onClose: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, any>>(row?.settings || {});
  const [inboundKey, setInboundKey] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["integrations"] }); qc.invalidateQueries({ queryKey: ["org"] }); };
  const save = useMutation({ mutationFn: () => put(`/integrations/${spec.kind}`, { credentials: creds, settings }), onSuccess: (r: any) => { if (r.inboundKey) setInboundKey(r.inboundKey); refresh(); } });
  const test = useMutation({ mutationFn: () => post(`/integrations/${spec.kind}/test`), onSuccess: (r: any) => { setTestMsg(r.detail); refresh(); } });
  const useAsCrm = useMutation({ mutationFn: () => api_patchCrm(spec.kind), onSuccess: refresh });
  const rotate = useMutation({ mutationFn: () => post(`/integrations/${spec.kind}/rotate-key`), onSuccess: (r: any) => setInboundKey(r.inboundKey) });
  const remove = useMutation({ mutationFn: () => del(`/integrations/${spec.kind}`), onSuccess: () => { refresh(); onClose(); } });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  const isSchedule = spec.group === "schedule";
  return (
    <Modal open onClose={onClose} title={spec.label} wide>
      <form onSubmit={submit} className="space-y-4">
        {spec.accessNote && <div className="rounded-xl bg-plum-wash text-plum text-sm px-3 py-2">{spec.accessNote}</div>}
        {spec.maturity === "unverified" && <div className="rounded-xl bg-warn-wash text-warn text-xs px-3 py-2">This connector follows the vendor's published API and is covered by tests, but has not yet run against a live account. Test it with the client's credentials before going live.</div>}
        {spec.credentialFields.map((f: any) => (
          <Field key={f.key} label={`${f.label}${f.required ? "" : " (optional)"}`} hint={f.help || (row?.secretsSet?.includes(f.key) ? "Saved — leave empty to keep it." : undefined)}>
            <input className="input" type={f.secret ? "password" : "text"} autoComplete="off" value={creds[f.key] || ""} onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })} disabled={!can("manager")} />
          </Field>
        ))}
        {spec.settingFields.map((f: any) => (
          <Field key={f.key} label={`${f.label}${f.required ? "" : " (optional)"}`} hint={f.help}>
            <input className="input" value={settings[f.key] ?? ""} onChange={(e) => setSettings({ ...settings, [f.key]: e.target.value })} disabled={!can("manager")} />
          </Field>
        ))}
        {spec.kind === "meta" && <Field label="Webhook verify token" hint="Any string; enter the same one in the Meta app's webhook settings."><input className="input" value={settings.verifyToken ?? ""} onChange={(e) => setSettings({ ...settings, verifyToken: e.target.value })} /></Field>}
        {endpoint && (row || inboundKey) && (
          <div className="rounded-xl border border-canvas-line p-3 text-sm space-y-2">
            <div className="font-medium">Where the platform sends leads</div>
            <code className="block break-all text-xs bg-canvas-tint rounded-lg p-2">{inboundKey ? endpoint.replace("<key>", inboundKey) : endpoint}</code>
            {inboundKey ? (
              <div className="text-xs text-warn">Copy this address now — the key is shown only once.{spec.kind === "angi" ? " Angi: put the key in the X-API-KEY field." : ""}
                <button type="button" className="ml-2 underline" onClick={() => navigator.clipboard?.writeText(endpoint.replace("<key>", inboundKey))}><Copy className="inline h-3 w-3" /> copy</button></div>
            ) : endpoint.includes("<key>") && can("owner") && <button type="button" className="btn-line btn-sm" onClick={() => rotate.mutate()}><KeyRound className="h-3.5 w-3.5" /> Issue a new key</button>}
          </div>
        )}
        <ErrorNote error={save.error || test.error || useAsCrm.error || rotate.error || remove.error} />
        {testMsg && <div className="rounded-xl bg-leaf-wash text-leaf-dark text-sm px-3 py-2">{testMsg}</div>}
        {save.isSuccess && !inboundKey && <div className="rounded-xl bg-leaf-wash text-leaf-dark text-sm px-3 py-2">Saved.</div>}
        {can("manager") && (
          <div className="flex flex-wrap justify-end gap-2">
            {row && can("owner") && <button type="button" className="btn-ghost text-bad mr-auto" onClick={() => { if (confirm(`Disconnect ${spec.label}?`)) remove.mutate(); }}>Disconnect</button>}
            {row && isSchedule && <button type="button" className="btn-line" onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? "Testing…" : "Test connection"}</button>}
            {isSchedule && (row || spec.kind === "native") && !isCrm && <button type="button" className="btn-line" onClick={() => useAsCrm.mutate()}>Use as schedule system</button>}
            {spec.kind !== "native" && <button className="btn-primary" disabled={save.isPending}>{save.isPending ? "Saving…" : row ? "Save" : "Connect"}</button>}
          </div>
        )}
      </form>
    </Modal>
  );
}

function api_patchCrm(kind: string) {
  return import("../lib/api").then(({ patch }) => patch("/org", { settings: { crm: kind } }));
}
