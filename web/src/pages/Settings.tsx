import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { del, get, patch, post } from "../lib/api";
import { clockToMinutes, minutesToClock, money, SOURCE_LABEL } from "../lib/format";
import { useSession } from "../lib/session";
import { ErrorNote, Field, Loading, PageHeader, Toggle } from "../components/ui";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function SettingsPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["org"], queryFn: () => get("/org") });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => get("/agents") });
  const [s, setS] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [areas, setAreas] = useState("");
  useEffect(() => {
    if (!q.data) return;
    setS(q.data.org.settings);
    setProfile({ name: q.data.org.name, timezone: q.data.org.timezone, industry: q.data.org.industry });
    setAreas(q.data.org.settings.serviceAreas.join(", "));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => patch("/org", { ...profile, settings: { ...s, serviceAreas: areas.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org"] }),
  });
  if (q.isLoading || !s || !profile) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const ro = !can("manager");
  const set = (k: string, v: any) => setS({ ...s, [k]: v });
  const live = (agents.data?.agents || []).filter((a: any) => a.status === "live");
  return (
    <div>
      <PageHeader title="Settings" subtitle="The business rules every agent follows. Saving re-publishes live agents." actions={!ro && <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save changes"}</button>} />
      <ErrorNote error={save.error} />
      {save.isSuccess && <div className="mb-4 rounded-xl bg-leaf-wash text-leaf-dark text-sm px-3 py-2">Saved{save.data?.republished ? ` · ${save.data.republished.ok} live agent(s) updated` : ""}.</div>}
      <div className="grid lg:grid-cols-2 gap-4">
        <section className="card p-5 space-y-4">
          <h2 className="font-semibold">Business</h2>
          <Field label="Business name"><input className="input" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} disabled={ro} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Time zone"><input className="input" value={profile.timezone} onChange={(e) => setProfile({ ...profile, timezone: e.target.value })} disabled={ro} placeholder="America/New_York" /></Field>
            <Field label="Industry">
              <select className="input" value={profile.industry} onChange={(e) => setProfile({ ...profile, industry: e.target.value })} disabled={ro}>
                {["hvac", "plumbing", "roofing", "solar", "electrical", "pest_control", "garage_door", "cleaning", "other"].map((i) => <option key={i} value={i}>{i.replace(/_/g, " ")}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Transfer calls to"><input className="input" value={s.transferNumber} onChange={(e) => set("transferNumber", e.target.value)} disabled={ro} placeholder="(212) 555-0100" /></Field>
            <Field label="Country code for local numbers"><input className="input" value={s.defaultCountryCode} onChange={(e) => set("defaultCountryCode", e.target.value)} disabled={ro} /></Field>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="font-semibold mb-3">Opening hours</h2>
          <div className="space-y-2">
            {DAYS.map((d, i) => {
              const h = s.businessHours[i];
              const upd = (v: any) => set("businessHours", s.businessHours.map((x: any, j: number) => (j === i ? v : x)));
              return (
                <div key={d} className="flex items-center gap-3 text-sm">
                  <span className="w-24">{d}</span>
                  <Toggle checked={!!h} onChange={(on) => upd(on ? { open: 480, close: 1020 } : null)} label="" />
                  {h ? (
                    <>
                      <input type="time" className="input h-8 w-28" value={minutesToClock(h.open)} onChange={(e) => upd({ ...h, open: clockToMinutes(e.target.value) })} disabled={ro} aria-label={`${d} opens`} />
                      <span className="text-ink-mute">to</span>
                      <input type="time" className="input h-8 w-28" value={minutesToClock(h.close)} onChange={(e) => upd({ ...h, close: clockToMinutes(e.target.value) })} disabled={ro} aria-label={`${d} closes`} />
                    </>
                  ) : <span className="text-ink-mute">Closed</span>}
                </div>
              );
            })}
          </div>
        </section>

        <section className="card p-5 space-y-3">
          <div className="flex items-center justify-between"><h2 className="font-semibold">Services & prices</h2>{!ro && <button className="btn-line btn-sm" onClick={() => set("services", [...s.services, { name: "", durationMinutes: 120, valueCents: 0 }])}><Plus className="h-3.5 w-3.5" /> Add</button>}</div>
          {s.services.length === 0 && <div className="text-sm text-ink-mute">No services yet. Agents then book a general service visit.</div>}
          {s.services.map((sv: any, i: number) => {
            const upd = (k: string, v: any) => set("services", s.services.map((x: any, j: number) => (j === i ? { ...x, [k]: v } : x)));
            return (
              <div key={i} className="grid grid-cols-[1fr_110px_120px_32px] gap-2 items-end">
                <Field label={i === 0 ? "Service" : ""}><input className="input" value={sv.name} onChange={(e) => upd("name", e.target.value)} disabled={ro} placeholder="AC repair" /></Field>
                <Field label={i === 0 ? "Minutes" : ""}><input className="input" type="number" min={15} max={480} value={sv.durationMinutes} onChange={(e) => upd("durationMinutes", Number(e.target.value))} disabled={ro} /></Field>
                <Field label={i === 0 ? "Typical ticket $" : ""}><input className="input" type="number" min={0} value={Math.round(sv.valueCents / 100)} onChange={(e) => upd("valueCents", Number(e.target.value) * 100)} disabled={ro} /></Field>
                {!ro && <button className="btn-ghost btn-sm h-10" onClick={() => set("services", s.services.filter((_: any, j: number) => j !== i))} aria-label="Remove"><Trash2 className="h-4 w-4" /></button>}
              </div>
            );
          })}
        </section>

        <section className="card p-5 space-y-3">
          <h2 className="font-semibold">Scheduling</h2>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Arrival window (min)"><input className="input" type="number" min={30} max={480} value={s.slotMinutes} onChange={(e) => set("slotMinutes", Number(e.target.value))} disabled={ro} /></Field>
            <Field label="Jobs per window"><input className="input" type="number" min={1} max={50} value={s.slotCapacity} onChange={(e) => set("slotCapacity", Number(e.target.value))} disabled={ro} /></Field>
            <Field label="Book up to (days)"><input className="input" type="number" min={1} max={60} value={s.bookingHorizonDays} onChange={(e) => set("bookingHorizonDays", Number(e.target.value))} disabled={ro} /></Field>
          </div>
          <Field label="Service area — postal codes" hint="Comma separated. End with * for a prefix (e.g. 112*). Empty = everywhere."><textarea className="textarea" value={areas} onChange={(e) => setAreas(e.target.value)} disabled={ro} /></Field>
        </section>

        <section className="card p-5 space-y-3 lg:col-span-2">
          <h2 className="font-semibold">Speed to lead & outbound calling</h2>
          <Toggle checked={s.speedToLead.enabled} onChange={(v) => set("speedToLead", { ...s.speedToLead, enabled: v })} label="Call every new lead automatically" />
          <div className="grid md:grid-cols-4 gap-3">
            <Field label="Agent that calls">
              <select className="input" value={s.speedToLead.agentId || ""} onChange={(e) => set("speedToLead", { ...s.speedToLead, agentId: e.target.value || null })} disabled={ro}>
                <option value="">Choose…</option>{live.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Attempts per lead"><input className="input" type="number" min={1} max={6} value={s.speedToLead.maxAttempts} onChange={(e) => set("speedToLead", { ...s.speedToLead, maxAttempts: Number(e.target.value) })} disabled={ro} /></Field>
            <Field label="Calling starts"><input type="time" className="input" value={minutesToClock(s.callingWindow.opens)} onChange={(e) => set("callingWindow", { ...s.callingWindow, opens: clockToMinutes(e.target.value) })} disabled={ro} /></Field>
            <Field label="Calling ends" hint="Never outside 8:00–21:00 local time."><input type="time" className="input" value={minutesToClock(s.callingWindow.closes)} onChange={(e) => set("callingWindow", { ...s.callingWindow, closes: clockToMinutes(e.target.value) })} disabled={ro} /></Field>
          </div>
          <Toggle checked={s.speedToLead.requireConsent} onChange={(v) => set("speedToLead", { ...s.speedToLead, requireConsent: v })} label="Only call people who agreed to be called (recommended — US law requires consent for automated calls)" />
          <div className="pt-2">
            <div className="text-sm font-medium">Agent per lead source</div>
            <p className="text-xs text-ink-mute mb-2">Pick a different agent for leads from a source. "Same as above" uses the agent chosen above.</p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {Object.entries(SOURCE_LABEL).filter(([k]) => !["phone", "manual"].includes(k)).map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 text-sm">
                  <span className="w-28 shrink-0 text-ink-soft">{label}</span>
                  <select className="input h-9" disabled={ro} value={s.speedToLead.agentBySource?.[k] || ""}
                    onChange={(e) => {
                      const next = { ...(s.speedToLead.agentBySource || {}) };
                      if (e.target.value) next[k] = e.target.value; else delete next[k];
                      set("speedToLead", { ...s.speedToLead, agentBySource: next });
                    }}>
                    <option value="">Same as above</option>
                    {live.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </div>
        </section>
      </div>
      <Team />
      <DncList />
      <Usage rate={q.data.org.rateCentsPerMinute} />
    </div>
  );
}

function Team() {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["members"], queryFn: () => get("/org/members") });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("manager");
  const [temp, setTemp] = useState<string | null>(null);
  const add = useMutation({ mutationFn: () => post("/org/members", { email, role }), onSuccess: (r: any) => { setTemp(r.tempPassword); setEmail(""); qc.invalidateQueries({ queryKey: ["members"] }); } });
  const rm = useMutation({ mutationFn: (id: string) => del(`/org/members/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }) });
  return (
    <section className="card p-5 mt-4">
      <h2 className="font-semibold mb-3">Team</h2>
      {q.data?.members?.map((m: any) => (
        <div key={m.id} className="flex items-center justify-between py-2 border-t border-canvas-line first:border-0 text-sm">
          <span>{m.name || m.email} <span className="text-ink-mute">· {m.email}</span></span>
          <span className="flex items-center gap-2"><span className="chip bg-canvas-deep text-ink-soft">{m.role}</span>{can("owner") && <button className="btn-ghost btn-sm" onClick={() => rm.mutate(m.id)} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></button>}</span>
        </div>
      ))}
      {can("owner") && (
        <form className="flex flex-wrap gap-2 mt-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <input className="input flex-1 min-w-[200px]" type="email" placeholder="colleague@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <select className="input w-32" value={role} onChange={(e) => setRole(e.target.value)}><option value="viewer">Viewer</option><option value="manager">Manager</option><option value="owner">Owner</option></select>
          <button className="btn-primary">Add</button>
        </form>
      )}
      {temp && <div className="mt-3 rounded-xl bg-warn-wash text-warn text-sm px-3 py-2">Temporary password (shown once): <code className="font-mono">{temp}</code></div>}
      <ErrorNote error={add.error || rm.error} />
    </section>
  );
}

function DncList() {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["dnc"], queryFn: () => get("/dnc") });
  const [phone, setPhone] = useState("");
  const add = useMutation({ mutationFn: () => post("/dnc", { phone }), onSuccess: () => { setPhone(""); qc.invalidateQueries({ queryKey: ["dnc"] }); } });
  return (
    <section className="card p-5 mt-4">
      <h2 className="font-semibold mb-1">Do-not-call list</h2>
      <p className="text-xs text-ink-mute mb-3">Numbers here are never called — by speed to lead, campaigns or anyone. Callers who ask to stop are added automatically.</p>
      {can("manager") && <form className="flex gap-2 mb-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}><input className="input w-64" placeholder="Phone number" value={phone} onChange={(e) => setPhone(e.target.value)} required /><button className="btn-line">Add</button></form>}
      <ErrorNote error={add.error} />
      <div className="text-sm max-h-48 overflow-y-auto">{q.data?.entries?.length ? q.data.entries.map((d: any) => <div key={d.phone_e164} className="flex justify-between py-1.5 border-t border-canvas-line first:border-0"><span className="tabular-nums">{d.phone_e164}</span><span className="text-ink-mute">{d.reason} · {d.source}</span></div>) : <span className="text-ink-mute">Empty.</span>}</div>
    </section>
  );
}

function Usage({ rate }: { rate: number }) {
  const q = useQuery({ queryKey: ["usage"], queryFn: () => get("/usage") });
  if (!q.data) return null;
  return (
    <section className="card p-5 mt-4">
      <h2 className="font-semibold mb-1">Usage this month</h2>
      <p className="text-xs text-ink-mute mb-3">Billed per minute of conversation, rounded up per call, at {money(rate)} / minute. Unanswered calls are free.</p>
      <div className="flex flex-wrap gap-6 text-sm"><div><div className="text-ink-mute text-xs">Calls</div><div className="text-xl font-semibold">{q.data.calls}</div></div><div><div className="text-ink-mute text-xs">Minutes</div><div className="text-xl font-semibold">{q.data.minutes}</div></div><div><div className="text-ink-mute text-xs">Charges</div><div className="text-xl font-semibold">{money(q.data.charge_cents)}</div></div></div>
    </section>
  );
}
