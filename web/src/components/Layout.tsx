import { NavLink, Outlet, Navigate, useLocation } from "react-router-dom";
import { useState } from "react";
import {
  LayoutDashboard, Bot, PhoneCall, Users, Inbox, CalendarDays, Megaphone, Plug, Settings, Shield, LogOut, Menu, Phone, X,
} from "lucide-react";
import { useSession } from "../lib/session";
import { Loading } from "./ui";

const NAV = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/agents", label: "Agents", icon: Bot },
  { to: "/app/calls", label: "Calls", icon: PhoneCall },
  { to: "/app/leads", label: "Leads", icon: Inbox },
  { to: "/app/customers", label: "Customers", icon: Users },
  { to: "/app/bookings", label: "Bookings", icon: CalendarDays },
  { to: "/app/campaigns", label: "Campaigns", icon: Megaphone },
  { to: "/app/numbers", label: "Phone numbers", icon: Phone },
  { to: "/app/integrations", label: "Integrations", icon: Plug },
  { to: "/app/settings", label: "Settings", icon: Settings },
];

export function Logo({ dark = false }: { dark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 font-display font-semibold text-lg">
      <img src="/pine.svg" alt="" className="h-7 w-7" />
      <span className={dark ? "text-white" : "text-ink"}>Pine AI</span>
    </span>
  );
}

export function AppLayout() {
  const { me, loading, switchOrg, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setOpen(false)}
          className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 h-9 text-sm ${isActive ? "bg-white shadow-card font-medium text-ink" : "text-ink-soft hover:bg-white/60"}`}>
          <n.icon className="h-4 w-4" /> {n.label}
        </NavLink>
      ))}
      {me.user.isPlatformAdmin && (
        <NavLink to="/app/admin" onClick={() => setOpen(false)}
          className={({ isActive }) => `mt-3 flex items-center gap-3 rounded-xl px-3 h-9 text-sm ${isActive ? "bg-ink text-white" : "text-plum hover:bg-plum-wash"}`}>
          <Shield className="h-4 w-4" /> Platform admin
        </NavLink>
      )}
    </nav>
  );
  const orgPicker = me.orgs.length > 0 && (
    <select className="input h-9 text-sm" value={me.orgId} onChange={(e) => switchOrg(e.target.value)} aria-label="Workspace">
      {!me.orgId && <option value="">Choose a client…</option>}
      {me.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="hidden lg:flex flex-col gap-5 border-r border-canvas-line bg-canvas-deep/60 p-4 sticky top-0 h-screen">
        <Logo />
        {orgPicker}
        <div className="flex-1 overflow-y-auto">{nav}</div>
        <div className="text-xs text-ink-mute border-t border-canvas-line pt-3">
          <div className="truncate font-medium text-ink-soft">{me.user.name || me.user.email}</div>
          <div className="truncate">{me.user.email}</div>
          <button className="mt-2 inline-flex items-center gap-1.5 hover:text-ink" onClick={signOut}><LogOut className="h-3.5 w-3.5" /> Sign out</button>
        </div>
      </aside>
      <header className="lg:hidden sticky top-0 z-30 flex items-center justify-between border-b border-canvas-line bg-canvas/90 backdrop-blur px-4 h-14">
        <Logo />
        <button className="btn-ghost btn-sm" onClick={() => setOpen(true)} aria-label="Menu"><Menu className="h-5 w-5" /></button>
      </header>
      {open && (
        <div className="lg:hidden fixed inset-0 z-40 bg-ink/30" onClick={() => setOpen(false)}>
          <div className="absolute left-0 top-0 h-full w-72 bg-canvas p-4 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between"><Logo /><button className="btn-ghost btn-sm" onClick={() => setOpen(false)} aria-label="Close"><X className="h-4 w-4" /></button></div>
            {orgPicker}
            {nav}
            <button className="btn-line mt-auto" onClick={signOut}><LogOut className="h-4 w-4" /> Sign out</button>
          </div>
        </div>
      )}
      <main className="min-w-0 px-4 py-6 lg:px-10 lg:py-8 max-w-[1280px] w-full">
        {!me.orgId && !loc.pathname.startsWith("/app/admin") ? (
          <div className="card p-8 text-center text-sm text-ink-mute">
            {me.user.isPlatformAdmin ? <>Choose a client above, or create one in <NavLink className="text-plum underline" to="/app/admin">Platform admin</NavLink>.</> : "Your account is not part of a workspace yet. Ask your Pine AI contact to add you."}
          </div>
        ) : <Outlet />}
      </main>
    </div>
  );
}
