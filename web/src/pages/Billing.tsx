import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CreditCard, MessageSquare, PhoneCall, Sparkles } from "lucide-react";
import { get, post } from "../lib/api";
import { useSession } from "../lib/session";
import { credits, cur, when } from "../lib/format";
import { ErrorNote, Loading, PageHeader, StatusChip } from "../components/ui";

declare global { interface Window { Razorpay?: any } }

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load the payment window."));
    document.body.appendChild(s);
  });
}

/** Opens Razorpay checkout for a server-created order and verifies the result on the server. */
async function pay(order: any, description: string): Promise<void> {
  await loadRazorpay();
  await new Promise<void>((resolve, reject) => {
    const rz = new window.Razorpay({
      key: order.keyId, order_id: order.orderId, amount: order.amount, currency: order.currency,
      name: "Pine AI", description, prefill: { name: order.name, email: order.email }, theme: { color: "#29561F" },
      handler: async (r: any) => { try { await post("/billing/verify", r); resolve(); } catch (e) { reject(e); } },
      modal: { ondismiss: () => reject(new Error("Payment was cancelled.")) },
    });
    rz.open();
  });
}

const FEATURES = ["AI agents answer every call, 24/7", "New leads called back in seconds", "Jobs booked straight into your schedule", "Dashboard, recordings, transcripts and call scores"];

/** The plan card: start the trial or pay for a month. Shown first when the paywall is on. */
export function PlanCard({ data, onDone }: { data: any; onDone: () => void }) {
  const { can } = useSession();
  const trial = useMutation({ mutationFn: () => post("/billing/trial"), onSuccess: onDone });
  const subscribe = useMutation({ mutationFn: async () => { const o = await post("/billing/subscribe/order"); await pay(o, "Pine AI — 1 month"); }, onSuccess: onDone });
  const owner = can("owner");
  return (
    <div className="card-roi rounded-3xl p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="eyebrow text-leaf/80">Pine AI plan</p>
          <div className="mt-3 flex items-baseline gap-2"><span className="num text-[52px] leading-none text-ink">{cur(data.price, data.currency)}</span><span className="text-ink-mute">/ month</span></div>
          <ul className="mt-5 space-y-2 text-sm text-ink-soft">{FEATURES.map((f) => <li key={f} className="flex gap-2"><Check className="h-4 w-4 text-leaf mt-0.5" />{f}</li>)}</ul>
        </div>
        <div className="w-full sm:w-64 space-y-3">
          <button className="btn-primary w-full h-11" disabled={!owner || subscribe.isPending || !data.payments_online} onClick={() => subscribe.mutate()}>
            <CreditCard className="h-4 w-4" /> {subscribe.isPending ? "Opening…" : data.status === "active" ? "Renew a month" : "Subscribe"}
          </button>
          {!data.trialUsed && data.trialDays > 0 && data.status !== "active" && (
            <button className="btn-line w-full h-11" disabled={!owner || trial.isPending} onClick={() => trial.mutate()}><Sparkles className="h-4 w-4" /> Start {data.trialDays}-day free trial</button>
          )}
          {!data.payments_online && <p className="text-xs text-ink-mute">Online payment is being set up. Your Pine AI contact can activate your plan.</p>}
          {!owner && <p className="text-xs text-ink-mute">Only the workspace owner can change the plan.</p>}
          <ErrorNote error={trial.error || subscribe.error} />
        </div>
      </div>
    </div>
  );
}

/** Full-page gate: the paywall is on and this workspace has no current plan. */
export function SubscribeGate() {
  const { refresh, me } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["billing"], queryFn: () => get("/billing") });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  return (
    <div className="max-w-3xl mx-auto py-6">
      <p className="eyebrow">Welcome{me?.user.name ? `, ${me.user.name.split(" ")[0]}` : ""}</p>
      <h1 className="text-[40px] leading-[1.08] mt-2">Choose your plan to start</h1>
      <p className="text-ink-mute mt-2">{q.data.status === "expired" ? "Your plan has ended. Renew to switch your agents back on." : "Your AI front desk is ready. Start the plan to use it."}</p>
      <div className="mt-8"><PlanCard data={q.data} onDone={() => { qc.invalidateQueries({ queryKey: ["billing"] }); refresh(); }} /></div>
    </div>
  );
}

export default function Billing() {
  const { refresh, can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["billing"], queryFn: () => get("/billing") });
  const [voice, setVoice] = useState(100);
  const [chat, setChat] = useState(0);
  const topup = useMutation({ mutationFn: async () => { const o = await post("/billing/topup/order", { voice, chat }); await pay(o, "Pine AI credits"); }, onSuccess: () => { qc.invalidateQueries({ queryKey: ["billing"] }); refresh(); } });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data;
  const sub = (voice > 0 ? voice / d.voicePerUnit : 0) + (chat > 0 ? chat / d.chatPerUnit : 0);
  const total = sub * (1 + d.taxPercent / 100);
  const done = () => { qc.invalidateQueries({ queryKey: ["billing"] }); refresh(); };

  return (
    <div>
      <PageHeader title="Billing" subtitle="Your plan, prepaid credits and payments." />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="glass rounded-2xl p-5">
          <div className="text-[13px] text-ink-soft">Plan</div>
          <div className="mt-2 flex items-center gap-2"><span className="num text-[30px]">{cur(d.price, d.currency)}</span><span className="text-ink-mute text-sm">/ month</span></div>
          <div className="mt-2 flex items-center gap-2 text-[13px]"><StatusChip status={d.active ? (d.status === "trial" ? "scheduled" : "active") : d.status === "inactive" ? "draft" : "paused"} />
            <span className="text-ink-mute">{d.status === "trial" ? `trial until ${when(d.trialEndsAt, { dateStyle: "medium" })}` : d.expiresAt ? `${d.active ? "renews" : "ended"} ${when(d.expiresAt, { dateStyle: "medium" })}` : "no plan yet"}</span></div>
        </div>
        <div className="glass rounded-2xl p-5">
          <div className="flex items-center gap-2 text-[13px] text-ink-soft"><PhoneCall className="h-4 w-4 text-leaf" /> Voice credits</div>
          <div className="num text-[38px] mt-1">{credits(d.wallet.voice)}</div>
          <div className="text-[13px] text-leaf">1 credit = 1 call-minute · {credits(d.month?.voice_used)} used this month</div>
        </div>
        <div className="glass rounded-2xl p-5">
          <div className="flex items-center gap-2 text-[13px] text-ink-soft"><MessageSquare className="h-4 w-4 text-leaf" /> Message credits</div>
          <div className="num text-[38px] mt-1">{credits(d.wallet.chat)}</div>
          <div className="text-[13px] text-leaf">1 credit = 1 message sent · {credits(d.month?.chat_used)} used this month</div>
        </div>
      </div>

      <div className="mt-6"><PlanCard data={d} onDone={done} /></div>

      <div className="card mt-6 p-5">
        <h2 className="eyebrow mb-4">Buy credits</h2>
        <div className="grid sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
          <label className="block"><span className="label">Voice credits (minutes)</span><input className="input" type="number" min={0} value={voice} onChange={(e) => setVoice(Math.max(0, Number(e.target.value)))} /></label>
          <label className="block"><span className="label">Message credits</span><input className="input" type="number" min={0} value={chat} onChange={(e) => setChat(Math.max(0, Number(e.target.value)))} /></label>
          <button className="btn-primary h-10" disabled={!can("owner") || !d.payments_online || topup.isPending || total <= 0} onClick={() => topup.mutate()}>Pay {cur(Math.round(total * 100) / 100, d.currency)}</button>
        </div>
        <p className="text-xs text-ink-mute mt-3">
          {credits(d.voicePerUnit)} voice credits and {credits(d.chatPerUnit)} message credits per {cur(1, d.currency)}{d.taxPercent ? `, plus ${d.taxPercent}% tax` : ""}.
          {!d.payments_online && " Online payment is being set up — your Pine AI contact can add credits."}
        </p>
        <ErrorNote error={topup.error} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mt-6">
        <div className="card overflow-x-auto">
          <div className="px-5 pt-5 eyebrow">Payments</div>
          <table className="w-full min-w-[420px] mt-2">
            <thead><tr><th className="th">Date</th><th className="th">For</th><th className="th text-right">Amount</th><th className="th">Status</th></tr></thead>
            <tbody>{d.payments.length ? d.payments.map((p: any) => (
              <tr key={p.id}><td className="td">{when(p.created_at, { dateStyle: "medium" })}</td><td className="td capitalize">{p.kind === "topup" ? `credits (${credits(Number(p.voice_credits))} voice, ${credits(Number(p.chat_credits))} msg)` : "plan"}</td><td className="td text-right tabular-nums">{cur(p.amount_minor / 100, p.currency)}</td><td className="td"><StatusChip status={p.status === "success" ? "completed" : p.status} /></td></tr>
            )) : <tr><td className="td text-ink-mute" colSpan={4}>No payments yet.</td></tr>}</tbody>
          </table>
        </div>
        <div className="card overflow-x-auto">
          <div className="px-5 pt-5 eyebrow">Credit history</div>
          <table className="w-full min-w-[420px] mt-2">
            <thead><tr><th className="th">When</th><th className="th">What</th><th className="th text-right">Credits</th></tr></thead>
            <tbody>{d.usage.length ? d.usage.map((u: any, i: number) => (
              <tr key={i}><td className="td">{when(u.created_at)}</td><td className="td">{u.kind === "voice" ? "Voice" : "Messages"} · {u.reason.replace(/[._]/g, " ")}</td><td className={`td text-right tabular-nums ${Number(u.delta) > 0 ? "text-leaf" : "text-ink-soft"}`}>{Number(u.delta) > 0 ? "+" : ""}{credits(Number(u.delta))}</td></tr>
            )) : <tr><td className="td text-ink-mute" colSpan={3}>Nothing yet.</td></tr>}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
