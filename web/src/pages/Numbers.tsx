import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, put } from "../lib/api";
import { useSession } from "../lib/session";
import { Empty, ErrorNote, Loading, PageHeader } from "../components/ui";

export default function Numbers() {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["numbers"], queryFn: () => get("/voice/numbers"), retry: false });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => get("/agents") });
  const route = useMutation({ mutationFn: ({ id, agentId }: { id: string; agentId: string | null }) => put(`/voice/numbers/${id}/inbound`, { agentId }), onSuccess: () => qc.invalidateQueries({ queryKey: ["numbers"] }) });
  const live = (agents.data?.agents || []).filter((a: any) => a.status === "live");
  return (
    <div>
      <PageHeader title="Phone numbers" subtitle="Choose which agent answers each number." />
      <ErrorNote error={route.error} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : !q.data.numbers.length ? <Empty title={q.data.connected === false ? "Calling is not connected yet" : "No numbers yet"} body={q.data.connected === false ? "Your Pine AI contact connects your voice workspace; your numbers appear here after that." : "Your Pine AI contact imports your existing number or connects your SIP trunk."} /> : (
        <div className="card divide-y divide-canvas-line">
          {q.data.numbers.map((n: any) => (
            <div key={n.id} className="flex flex-wrap items-center gap-4 px-4 py-4">
              <div className="flex-1 min-w-[200px]">
                <div className="font-medium tabular-nums">{n.e164}</div>
                <div className="text-xs text-ink-mute">{n.label || "—"} · {n.supports_inbound ? "inbound" : ""}{n.supports_inbound && n.supports_outbound ? " + " : ""}{n.supports_outbound ? "outbound" : ""}</div>
                {n.inbound_setup && n.inbound_setup !== "ready" && <div className="text-xs text-warn mt-1">Inbound setup: {String(n.inbound_setup).replace(/_/g, " ")}</div>}
              </div>
              <select className="input w-64" disabled={!can("manager") || !n.supports_inbound || route.isPending} value={n.inbound_agent_id || ""}
                onChange={(e) => route.mutate({ id: n.id, agentId: e.target.value || null })} aria-label={`Agent for ${n.e164}`}>
                <option value="">Nobody answers (off)</option>
                {live.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
