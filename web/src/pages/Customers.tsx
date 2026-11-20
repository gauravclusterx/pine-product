import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { get } from "../lib/api";
import { ago } from "../lib/format";
import { Empty, ErrorNote, Loading, PageHeader } from "../components/ui";

export default function Customers() {
  const [s, setS] = useState("");
  const [term, setTerm] = useState("");
  const q = useQuery({ queryKey: ["customers", term], queryFn: () => get(`/customers?limit=100&q=${encodeURIComponent(term)}`) });
  return (
    <div>
      <PageHeader title="Customers" subtitle="Everyone who called or was called. Agents remember each of them." actions={
        <form onSubmit={(e) => { e.preventDefault(); setTerm(s); }} className="relative">
          <Search className="h-4 w-4 absolute left-3 top-3 text-ink-mute" />
          <input className="input pl-9 w-64" placeholder="Name, phone or email" value={s} onChange={(e) => setS(e.target.value)} aria-label="Search customers" />
        </form>
      } />
      {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : !q.data.customers.length ? <Empty title={term ? "No match" : "No customers yet"} /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead><tr><th className="th">Customer</th><th className="th">Phone</th><th className="th">Area</th><th className="th">Calls</th><th className="th">Last call</th></tr></thead>
            <tbody>{q.data.customers.map((c: any) => (
              <tr key={c.id} className="hover:bg-canvas-tint cursor-pointer">
                <td className="td"><Link to={`/app/customers/${c.id}`} className="font-medium hover:text-plum">{c.name || "Unnamed"}</Link>{c.connector && <span className="ml-2 chip bg-canvas-deep text-ink-mute">{c.connector}</span>}</td>
                <td className="td tabular-nums">{c.phone_e164}</td>
                <td className="td text-ink-soft">{c.address?.postalCode || "—"}</td>
                <td className="td tabular-nums">{c.calls}</td>
                <td className="td text-ink-mute">{ago(c.last_call_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
