import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";
import { money } from "../lib/format";
import { Empty, ErrorNote, Loading, PageHeader, StatusChip } from "../components/ui";

export default function Bookings() {
  const q = useQuery({ queryKey: ["bookings"], queryFn: () => get("/bookings") });
  const org = useQuery({ queryKey: ["org"], queryFn: () => get("/org") });
  const tz = org.data?.org?.timezone || undefined;
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const groups = new Map<string, any[]>();
  for (const b of q.data.bookings) {
    const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(new Date(b.starts_at));
    groups.set(day, [...(groups.get(day) || []), b]);
  }
  const time = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  return (
    <div>
      <PageHeader title="Bookings" subtitle={`Jobs booked by your agents${tz ? ` · times in ${tz}` : ""}.`} />
      {!q.data.bookings.length ? <Empty title="No bookings in the next 30 days" body="When an agent books a job it appears here and in your schedule system." /> : (
        <div className="space-y-5">
          {Array.from(groups.entries()).map(([day, list]) => (
            <div key={day}>
              <h2 className="text-sm font-semibold text-ink-soft mb-2">{day}</h2>
              <div className="card divide-y divide-canvas-line">
                {list.map((b) => (
                  <div key={b.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
                    <div className="w-36 text-sm font-medium tabular-nums">{time(b.starts_at)} – {time(b.ends_at)}</div>
                    <div className="flex-1 min-w-[160px]"><div className="text-sm font-medium">{b.customer_name || b.phone_e164}</div><div className="text-xs text-ink-mute">{b.job_type}</div></div>
                    <div className="text-xs text-ink-mute">{b.connector === "native" ? "Pine AI calendar" : b.connector}{b.external_job_id ? ` #${b.external_job_id}` : ""}</div>
                    <div className="text-sm tabular-nums w-20 text-right">{b.value_cents ? money(b.value_cents) : ""}</div>
                    <StatusChip status={b.status} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
