import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Inbox } from "lucide-react";
import { get } from "../lib/api";
import { ago, money, num, pct, SOURCE_LABEL, OUTCOME_LABEL } from "../lib/format";
import { Bars, ErrorNote, Loading, PageHeader, Stat } from "../components/ui";

/** Alerts start with an emoji for Slack; the feed has its own icons. */
const stripEmoji = (t: unknown) => String(t || "").replace(/^\p{Extended_Pictographic}️?\s*/u, "");

export default function Dashboard() {
  const [days, setDays] = useState(30);
  const { data, isLoading, error } = useQuery({ queryKey: ["dashboard", days], queryFn: () => get(`/dashboard?days=${days}`), refetchInterval: 60_000 });
  const org = useQuery({ queryKey: ["org"], queryFn: () => get("/org") });
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const d = data;
  const voiceOff = org.data && !org.data.voice.connected;
  return (
    <div>
      <PageHeader
        title={org.data?.org?.name || "Dashboard"}
        subtitle="Calls, bookings and leads across every agent."
        actions={
          <div className="flex rounded-full bg-canvas-deep p-1 text-xs">
            {[7, 30, 90].map((n) => (
              <button key={n} onClick={() => setDays(n)} className={`rounded-full px-3 h-7 ${days === n ? "bg-white shadow-card font-medium" : "text-ink-mute"}`}>{n} days</button>
            ))}
          </div>
        }
      />
      {voiceOff && (
        <div className="mb-6 rounded-2xl border border-warn/30 bg-warn-wash px-4 py-3 text-sm text-warn flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> Calling is not connected for this workspace yet. Your Pine AI contact connects it.
        </div>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Jobs booked" value={num(d.bookings.total)} hint={`${money(d.bookings.value_cents)} estimated revenue`} tone="leaf" />
        <Stat label="Calls handled" value={num(d.calls.total)} hint={`${num(d.calls.inbound)} in · ${num(d.calls.outbound)} out`} />
        <Stat label="Booking rate" value={pct(d.calls.bookingRate)} hint="of calls that connected" tone="plum" />
        <Stat label="Speed to lead" value={d.leads.median_seconds_to_call == null ? "—" : `${d.leads.median_seconds_to_call}s`} hint={`${num(d.leads.called_within_60s)} of ${num(d.leads.called)} called within 60s`} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        <div className="card p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Calls per day</h2>
            <div className="flex items-center gap-3 text-xs text-ink-mute"><span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-canvas-deep" />calls</span><span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-leaf" />booked</span></div>
          </div>
          {d.daily.length ? <Bars data={d.daily.map((x: any) => ({ label: String(new Date(x.day).getUTCDate()), a: x.calls, b: x.booked }))} /> : <div className="text-sm text-ink-mute py-10 text-center">No calls in this period yet.</div>}
        </div>
        <div className="card p-5">
          <h2 className="font-semibold mb-3">Outcomes</h2>
          <div className="space-y-2">
            {d.outcomes.length ? d.outcomes.map((o: any) => (
              <div key={o.outcome} className="flex items-center gap-3 text-sm">
                <span className="w-28 text-ink-soft">{OUTCOME_LABEL[o.outcome] || o.outcome}</span>
                <div className="flex-1 h-2 rounded-full bg-canvas-deep overflow-hidden"><div className={`h-full ${o.outcome === "booked" ? "bg-leaf" : "bg-plum-soft"}`} style={{ width: `${(o.n / Math.max(1, d.calls.total)) * 100}%` }} /></div>
                <span className="w-8 text-right tabular-nums">{o.n}</span>
              </div>
            )) : <div className="text-sm text-ink-mute">Nothing yet.</div>}
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        <div className="card p-5">
          <h2 className="font-semibold mb-3">Leads by source</h2>
          {d.bySource.length ? (
            <table className="w-full text-sm"><tbody>
              {d.bySource.map((s: any) => (
                <tr key={s.source} className="border-t border-canvas-line first:border-0"><td className="py-2">{SOURCE_LABEL[s.source] || s.source}</td><td className="py-2 text-right tabular-nums">{s.leads}</td><td className="py-2 pl-3 text-right text-leaf-dark tabular-nums whitespace-nowrap">{s.booked} booked</td></tr>
              ))}
            </tbody></table>
          ) : <div className="text-sm text-ink-mute">No leads yet. Connect a lead source in <Link to="/app/integrations" className="underline">Integrations</Link>.</div>}
          <div className="mt-3 text-xs text-ink-mute">{num(d.leads.lost)} lost · {num(d.leads.rejected)} outside your rules</div>
        </div>
        <div className="card p-5">
          <h2 className="font-semibold mb-3">Agents</h2>
          {d.agents.length ? d.agents.map((a: any) => (
            <Link to={`/app/agents/${a.id}`} key={a.id} className="flex items-center justify-between py-2 border-t border-canvas-line first:border-0 text-sm hover:text-plum">
              <span>{a.name}</span><span className="text-ink-mute tabular-nums">{a.calls} calls · {a.booked} booked{a.avg_qa != null ? ` · QA ${a.avg_qa}` : ""}</span>
            </Link>
          )) : <div className="text-sm text-ink-mute">No agents yet.</div>}
          <div className="mt-3 text-xs text-ink-mute">Average call score: {d.calls.avg_qa ?? "—"} · {num(d.calls.second_chance)} second chances flagged</div>
        </div>
        <div className="card p-5">
          <h2 className="font-semibold mb-3">Activity</h2>
          <div className="space-y-3">
            {d.feed.length ? d.feed.slice(0, 8).map((f: any, i: number) => (
              <div key={i} className="flex gap-2 text-sm">
                {f.action === "lead.received" ? <Inbox className="h-4 w-4 text-plum mt-0.5" /> : f.action === "call.second_chance" ? <AlertTriangle className="h-4 w-4 text-warn mt-0.5" /> : <CheckCircle2 className="h-4 w-4 text-leaf mt-0.5" />}
                <div className="min-w-0">
                  <div className="truncate">{f.action === "lead.received" ? `New lead from ${SOURCE_LABEL[f.detail.source] || f.detail.source}${f.detail.rejected ? " (rejected)" : ""}` : f.action === "call.second_chance" ? `Second chance: ${f.detail.summary || "missed booking"}` : stripEmoji(f.detail.text)}</div>
                  <div className="text-xs text-ink-mute">{ago(f.created_at)}</div>
                </div>
              </div>
            )) : <div className="text-sm text-ink-mute">Quiet so far.</div>}
          </div>
        </div>
      </div>
      <div className="mt-4 text-xs text-ink-mute">{num(d.calls.minutes)} billable minutes · {money(d.calls.charge_cents)} this period</div>
    </div>
  );
}
