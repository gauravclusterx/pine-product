import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, CheckCircle2, Inbox, Wrench, PhoneIncoming, PhoneOutgoing, CalendarCheck } from "lucide-react";
import { get } from "../lib/api";
import { ago, money, moneyShort, num, pct, SOURCE_LABEL, OUTCOME_LABEL, when } from "../lib/format";
import { AreaChart, ErrorNote, Loading, Segmented, Stat } from "../components/ui";

/** Alerts start with an emoji for Slack; the feed has its own icons. */
const stripEmoji = (t: unknown) => String(t || "").replace(/^\p{Extended_Pictographic}️?\s*/u, "");
const RANGES = [{ value: 30, label: "30 d" }, { value: 90, label: "90 d" }, { value: 180, label: "6 mo" }];

/** Group daily rows into weeks or months so long ranges stay readable, then make the series cumulative. */
function series(rows: Array<{ day: string; revenue_cents: number; cost_cents: number }>, days: number) {
  const key = (d: Date) => days > 120 ? `${d.getUTCFullYear()}-${d.getUTCMonth()}` : days > 45 ? `${Math.floor(d.getTime() / (7 * 86_400_000))}` : d.toISOString().slice(0, 10);
  const label = (d: Date) => days > 120 ? d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }) : d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const buckets: Array<{ x: string; rev: number; cost: number }> = [];
  let last = "";
  for (const r of rows) {
    const d = new Date(r.day);
    const k = key(d);
    if (k !== last) { buckets.push({ x: label(d), rev: 0, cost: 0 }); last = k; }
    buckets[buckets.length - 1].rev += r.revenue_cents;
    buckets[buckets.length - 1].cost += r.cost_cents;
  }
  let rev = 0, cost = 0;
  return buckets.map((b) => { rev += b.rev; cost += b.cost; return { x: b.x, rev, cost }; });
}

export default function Dashboard() {
  const [days, setDays] = useState(30);
  const { data, isLoading, error } = useQuery({ queryKey: ["dashboard", days], queryFn: () => get(`/dashboard?days=${days}`), refetchInterval: 60_000 });
  const org = useQuery({ queryKey: ["org"], queryFn: () => get("/org") });
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const d = data;
  const o = org.data?.org;
  const voiceOff = org.data && !org.data.voice.connected;
  const revenue = d.bookings.value_cents;
  const cost = d.calls.charge_cents;
  const roi = cost > 0 ? revenue / cost : null;
  const s = series(d.money || [], days);
  const rangeLabel = days === 180 ? "6 months" : `${days} days`;
  const bookedRecent = (d.recentBookings || []).reduce((a: number, b: any) => a + (b.value_cents || 0), 0);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <h1 className="text-[34px] sm:text-[40px] leading-[1.08] text-ink">{o?.name || "Dashboard"}</h1>
          <p className="text-[15px] text-ink-mute mt-2">
            {[o?.industry && o.industry.replace(/_/g, " "), o?.timezone, `last ${rangeLabel}`].filter(Boolean).map((x, i) => <span key={i} className="capitalize-first">{i ? " · " : ""}{x}</span>)}
          </p>
        </div>
        <Segmented value={days} options={RANGES} onChange={setDays} />
      </div>

      {voiceOff && (
        <div className="mt-6 rounded-2xl bg-warn-wash shadow-[inset_0_0_0_1px_rgba(240,201,135,0.25)] px-4 py-3 text-sm text-warn flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" /> Calling is not connected for this workspace yet. Your Pine AI contact connects it.
        </div>
      )}

      <div className="mt-7 grid gap-6 xl:grid-cols-[1fr_330px]">
        <div className="min-w-0">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <Stat label="Calls answered" value={num(d.calls.total)} hint={d.calls.total ? `${pct(d.calls.after_hours / d.calls.total)} after hours` : "no calls yet"} />
            <Stat label="Jobs booked" value={num(d.bookings.total)} hint={`${pct(d.calls.bookingRate)} booking rate`} />
            <Stat label="Booked revenue" value={moneyShort(revenue)} hint={rangeLabel} />
            <Stat label="Return on Pine AI" value={roi == null ? "—" : `${roi >= 10 ? Math.round(roi) : roi.toFixed(1)}×`} hint="booked revenue / cost" tone="roi" />
          </div>

          <div className="mt-4 rounded-2xl well p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
              <h2 className="text-[15px] text-ink-soft">Booked revenue from Pine AI calls</h2>
              <div className="flex items-center gap-4 text-xs text-ink-mute">
                <span className="inline-flex items-center gap-2"><i className="inline-block w-4 h-[2px] bg-leaf" />Revenue</span>
                <span className="inline-flex items-center gap-2"><i className="inline-block w-4 border-t-[1.5px] border-dashed border-white/50" />Pine AI cost</span>
              </div>
            </div>
            <AreaChart
              points={s.map((p) => ({ x: p.x, y: p.rev }))}
              compare={s.map((p) => p.cost)}
              format={(v) => moneyShort(v)}
              labelEnd={s.length ? `+${moneyShort(s[s.length - 1].rev)} ${s[s.length - 1].x}` : undefined}
            />
          </div>
        </div>

        <aside className="xl:border-l xl:border-white/10 xl:pl-6">
          <div className="flex items-baseline justify-between">
            <h2 className="eyebrow">Booked recently</h2>
            <span className="num text-[28px] text-leaf-light">+{moneyShort(bookedRecent)}</span>
          </div>
          <div className="mt-4 space-y-3">
            {(d.recentBookings || []).length ? d.recentBookings.map((b: any) => (
              <div key={b.id} className="glass rounded-2xl p-4 flex gap-3.5">
                <div className="h-11 w-11 shrink-0 rounded-xl bg-white/[0.07] shadow-card grid place-items-center text-ink-soft">
                  {b.direction === "outbound" ? <PhoneOutgoing className="h-4.5 w-4.5" /> : b.direction === "inbound" ? <PhoneIncoming className="h-4.5 w-4.5" /> : <Wrench className="h-4.5 w-4.5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink truncate">{b.job_type || "Job"}</div>
                  <div className="mt-1 flex items-start gap-1.5 text-[13px] text-leaf">
                    <Check className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>{b.seconds_to_call != null && b.seconds_to_call >= 0 && b.seconds_to_call < 3600 ? `Called back in ${b.seconds_to_call} s` : `Booked ${when(b.starts_at, { weekday: "short", hour: "numeric", minute: "2-digit" })}`}</span>
                  </div>
                  <div className="text-xs text-ink-mute mt-1">{b.customer_name ? `${b.customer_name} · ` : ""}{ago(b.created_at)}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="num text-[22px] text-ink">+{moneyShort(b.value_cents)}</div>
                  <div className="text-xs text-ink-mute">booked</div>
                </div>
              </div>
            )) : (
              <div className="glass rounded-2xl p-5 text-sm text-ink-mute">
                <CalendarCheck className="h-5 w-5 text-leaf mb-2" />
                No jobs booked yet. As soon as an agent books one, it shows up here.
              </div>
            )}
          </div>
          <p className="text-xs text-ink-mute mt-4 leading-relaxed">
            Revenue is the estimated job value from your price book. Cost is Pine AI usage: {num(d.calls.minutes)} billable minutes, {money(cost)} this period.
          </p>
        </aside>
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mt-8">
        <div className="card p-5">
          <h2 className="eyebrow mb-4">Call outcomes</h2>
          <div className="space-y-3">
            {d.outcomes.length ? d.outcomes.map((x: any) => (
              <div key={x.outcome} className="flex items-center gap-3 text-sm">
                <span className="w-28 text-ink-soft">{OUTCOME_LABEL[x.outcome] || x.outcome}</span>
                <div className="flex-1 h-1.5 rounded-full bg-white/[0.07] overflow-hidden"><div className={`h-full rounded-full ${x.outcome === "booked" ? "bg-leaf" : "bg-white/30"}`} style={{ width: `${(x.n / Math.max(1, d.calls.total)) * 100}%` }} /></div>
                <span className="w-8 text-right tabular-nums text-ink-soft">{x.n}</span>
              </div>
            )) : <div className="text-sm text-ink-mute">Nothing yet.</div>}
          </div>
          <div className="mt-5 pt-4 border-t border-canvas-line grid grid-cols-2 gap-3 text-sm">
            <div><div className="text-ink-mute text-xs">Speed to lead</div><div className="num text-2xl mt-1">{d.leads.median_seconds_to_call == null ? "—" : `${d.leads.median_seconds_to_call}s`}</div></div>
            <div><div className="text-ink-mute text-xs">Call score</div><div className="num text-2xl mt-1">{d.calls.avg_qa ?? "—"}</div></div>
          </div>
        </div>

        <div className="card p-5">
          <h2 className="eyebrow mb-4">Leads by source</h2>
          {d.bySource.length ? (
            <div className="space-y-0.5">
              {d.bySource.map((x: any) => (
                <div key={x.source} className="flex items-center justify-between py-2.5 border-t border-canvas-line first:border-0 text-sm">
                  <span className="text-ink-soft">{SOURCE_LABEL[x.source] || x.source}</span>
                  <span className="tabular-nums"><span className="text-ink">{x.leads}</span><span className="text-leaf ml-3">{x.booked} booked</span></span>
                </div>
              ))}
            </div>
          ) : <div className="text-sm text-ink-mute">No leads yet. Connect a lead source in <Link to="/app/integrations" className="text-leaf underline">Integrations</Link>.</div>}
          <div className="mt-3 text-xs text-ink-mute">{num(d.leads.called_within_60s)} of {num(d.leads.called)} called within 60s · {num(d.leads.lost)} lost</div>
        </div>

        <div className="card p-5">
          <h2 className="eyebrow mb-4">Activity</h2>
          <div className="space-y-3.5">
            {d.feed.length ? d.feed.slice(0, 6).map((f: any, i: number) => (
              <div key={i} className="flex gap-3 text-sm">
                {f.action === "lead.received" ? <Inbox className="h-4 w-4 text-plum mt-0.5 shrink-0" /> : f.action === "call.second_chance" ? <AlertTriangle className="h-4 w-4 text-warn mt-0.5 shrink-0" /> : <CheckCircle2 className="h-4 w-4 text-leaf mt-0.5 shrink-0" />}
                <div className="min-w-0">
                  <div className="truncate text-ink-soft">{f.action === "lead.received" ? `New lead from ${SOURCE_LABEL[f.detail.source] || f.detail.source}${f.detail.rejected ? " (rejected)" : ""}` : f.action === "call.second_chance" ? `Second chance: ${f.detail.summary || "missed booking"}` : stripEmoji(f.detail.text)}</div>
                  <div className="text-xs text-ink-mute">{ago(f.created_at)}</div>
                </div>
              </div>
            )) : <div className="text-sm text-ink-mute">Quiet so far.</div>}
          </div>
        </div>
      </div>

      {d.agents.length > 0 && (
        <div className="card mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px]">
            <thead><tr><th className="th">Agent</th><th className="th text-right">Calls</th><th className="th text-right">Booked</th><th className="th text-right">Call score</th></tr></thead>
            <tbody>{d.agents.map((a: any) => (
              <tr key={a.id} className="hover:bg-white/[0.03]">
                <td className="td"><Link to={`/app/agents/${a.id}`} className="text-ink hover:text-leaf">{a.name}</Link></td>
                <td className="td text-right tabular-nums">{a.calls}</td>
                <td className="td text-right tabular-nums text-leaf">{a.booked}</td>
                <td className="td text-right tabular-nums">{a.avg_qa ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
