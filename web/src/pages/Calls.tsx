import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PhoneIncoming, PhoneOutgoing, Globe } from "lucide-react";
import { get } from "../lib/api";
import { duration, money, when } from "../lib/format";
import { Empty, ErrorNote, Loading, OutcomeChip, PageHeader } from "../components/ui";

export default function Calls() {
  const [outcome, setOutcome] = useState("");
  const [direction, setDirection] = useState("");
  const [page, setPage] = useState(0);
  const qs = new URLSearchParams({ limit: "50", offset: String(page * 50), ...(outcome ? { outcome } : {}), ...(direction ? { direction } : {}) }).toString();
  const q = useQuery({ queryKey: ["calls", qs], queryFn: () => get(`/calls?${qs}`), refetchInterval: 20_000 });
  return (
    <div>
      <PageHeader title="Calls" subtitle="Every call your agents handled, with transcript, recording and score." actions={
        <>
          <select className="input h-9 w-36" value={direction} onChange={(e) => { setDirection(e.target.value); setPage(0); }} aria-label="Direction"><option value="">All directions</option><option value="inbound">Inbound</option><option value="outbound">Outbound</option><option value="web">Test calls</option></select>
          <select className="input h-9 w-40" value={outcome} onChange={(e) => { setOutcome(e.target.value); setPage(0); }} aria-label="Outcome">
            <option value="">All outcomes</option>{["booked", "callback", "quote", "info", "transferred", "no_contact", "not_interested", "opt_out", "unknown"].map((o) => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}
          </select>
        </>
      } />
      {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : !q.data.calls.length ? <Empty title="No calls yet" body="Calls appear here seconds after they end." /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead><tr><th className="th">When</th><th className="th">Customer</th><th className="th">Agent</th><th className="th">Duration</th><th className="th">Outcome</th><th className="th">Score</th><th className="th">Charge</th></tr></thead>
            <tbody>
              {q.data.calls.map((c: any) => (
                <tr key={c.id} className="hover:bg-canvas-tint">
                  <td className="td whitespace-nowrap"><Link to={`/app/calls/${c.id}`} className="inline-flex items-center gap-2 hover:text-plum">
                    {c.direction === "inbound" ? <PhoneIncoming className="h-4 w-4 text-leaf" /> : c.direction === "outbound" ? <PhoneOutgoing className="h-4 w-4 text-plum" /> : <Globe className="h-4 w-4 text-ink-mute" />}{when(c.started_at)}</Link></td>
                  <td className="td"><Link to={`/app/calls/${c.id}`} className="hover:text-plum"><div className="font-medium">{c.customer_name || c.phone_e164 || "Unknown"}</div>{c.summary && <div className="text-xs text-ink-mute line-clamp-1 max-w-sm">{c.summary}</div>}</Link></td>
                  <td className="td text-ink-soft">{c.agent_name || "—"}</td>
                  <td className="td tabular-nums">{c.status === "ended" ? duration(c.duration_seconds) : <span className="chip bg-plum-wash text-plum">{c.status}</span>}</td>
                  <td className="td"><OutcomeChip outcome={c.outcome} /></td>
                  <td className="td tabular-nums">{c.qa_score ?? "—"}</td>
                  <td className="td tabular-nums">{money(c.charge_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex justify-between items-center p-3 text-sm">
            <button className="btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            <span className="text-ink-mute">Page {page + 1}</span>
            <button className="btn-ghost btn-sm" disabled={q.data.calls.length < 50} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
