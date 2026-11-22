import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Languages, Loader2 } from "lucide-react";
import { get, post } from "../lib/api";
import { duration, money, when } from "../lib/format";
import { ErrorNote, Loading, OutcomeChip, PageHeader } from "../components/ui";

export default function CallDetail() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ["call", id], queryFn: () => get(`/calls/${id}`) });
  const org = useQuery({ queryKey: ["org"], queryFn: () => get("/org") });
  const [english, setEnglish] = useState<string[] | null>(null);
  const [showEnglish, setShowEnglish] = useState(false);
  const tr = useMutation({ mutationFn: () => post(`/calls/${id}/translate`), onSuccess: (r: any) => { setEnglish(r.lines); setShowEnglish(true); } });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const c = q.data.call;
  const lines: string[] = showEnglish && (english || c.qa?.transcriptEn) ? (english || c.qa.transcriptEn) : (c.transcript || []);
  const qa = c.qa && c.qa.breakdown ? c.qa : null;
  const ex = c.extraction || {};
  const toggleEnglish = () => {
    if (showEnglish) return setShowEnglish(false);
    if (english || c.qa?.transcriptEn) return setShowEnglish(true);
    tr.mutate();
  };
  return (
    <div>
      <Link to="/app/calls" className="inline-flex items-center gap-1 text-sm text-ink-mute hover:text-ink mb-3"><ArrowLeft className="h-4 w-4" /> Calls</Link>
      <PageHeader title={c.customer_name || c.phone_e164 || "Unknown caller"} subtitle={`${c.direction} · ${when(c.started_at, { dateStyle: "medium", timeStyle: "short" })} · ${duration(c.duration_seconds)} · ${c.agent_name || "agent"}`}
        actions={<OutcomeChip outcome={c.outcome} />} />
      <div className="grid lg:grid-cols-[1fr_340px] gap-4">
        <div className="space-y-4">
          {c.summary && <div className="card p-5"><h2 className="font-semibold mb-2">Summary</h2><p className="text-sm text-ink-soft">{c.summary}</p></div>}
          {c.recording_available && (
            <div className="card p-5"><h2 className="font-semibold mb-3">Recording</h2><audio controls preload="none" className="w-full" src={`/api/calls/${c.id}/recording`} /></div>
          )}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold">Transcript</h2>
              {lines.length > 0 && (
                <button className="btn-line btn-sm" onClick={toggleEnglish} disabled={tr.isPending || (org.data && !org.data.translation && !c.qa?.transcriptEn)}
                  title={org.data && !org.data.translation ? "Translation needs an OpenAI key on the server" : undefined}>
                  {tr.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Languages className="h-3.5 w-3.5" />}
                  {showEnglish ? "Show original" : "Translate to English"}
                </button>
              )}
            </div>
            <ErrorNote error={tr.error} />
            {lines.length ? (
              <div className="space-y-2">
                {lines.map((l, i) => {
                  const ai = /^AI:/i.test(l);
                  return (
                    <div key={i} className={`flex ${ai ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${ai ? "bg-leaf-wash text-ink rounded-tr-sm" : "bg-white/[0.06] rounded-tl-sm"}`}>{l.replace(/^(AI|Customer):\s*/i, "")}</div>
                    </div>
                  );
                })}
              </div>
            ) : <div className="text-sm text-ink-mute">No transcript for this call.</div>}
          </div>
        </div>
        <div className="space-y-4">
          <div className="card p-5">
            <h2 className="font-semibold mb-3">Call score</h2>
            {qa ? (
              <>
                <div className="text-4xl font-semibold font-display">{qa.score}<span className="text-base text-ink-mute">/100</span></div>
                <div className="mt-3 space-y-2">
                  {[["Greeting", qa.breakdown.greeting, 25], ["Discovery", qa.breakdown.discovery, 25], ["Booking", qa.breakdown.booking, 35], ["Courtesy", qa.breakdown.courtesy, 15]].map(([k, v, max]: any) => (
                    <div key={k} className="text-xs"><div className="flex justify-between"><span>{k}</span><span className="tabular-nums">{v}/{max}</span></div><div className="h-1.5 rounded-full bg-canvas-deep mt-1"><div className="h-full rounded-full bg-leaf" style={{ width: `${(v / max) * 100}%` }} /></div></div>
                  ))}
                </div>
                {qa.secondChance && <div className="mt-3 rounded-xl bg-warn-wash text-warn text-xs px-3 py-2">Second chance: the customer wanted service but nothing was booked.</div>}
                {qa.coaching?.length > 0 && <ul className="mt-3 list-disc pl-4 text-xs text-ink-soft space-y-1">{qa.coaching.map((t: string) => <li key={t}>{t}</li>)}</ul>}
              </>
            ) : <div className="text-sm text-ink-mute">{c.qa?.skipped ? "Not scored — nobody spoke." : "Scored once the call's results are final."}</div>}
          </div>
          <div className="card p-5 text-sm space-y-2">
            <h2 className="font-semibold mb-1">Details</h2>
            {[["Phone", c.phone_e164 || "—"], ["Service", ex.service_requested || "—"], ["Urgency", ex.urgency || "—"], ["Sentiment", ex.sentiment || "—"], ["Callback", ex.callback_time || "—"], ["Ended", (c.ended_reason || "—").replace(/_/g, " ")], ["Billed", `${duration(c.billable_seconds)} · ${money(c.charge_cents)}`]].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3"><span className="text-ink-mute">{k}</span><span className="text-right">{v}</span></div>
            ))}
            {c.customer_id && <Link to={`/app/customers/${c.customer_id}`} className="btn-line btn-sm w-full mt-2">Open customer</Link>}
          </div>
        </div>
      </div>
    </div>
  );
}
