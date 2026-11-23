import { NavLink, Outlet, Navigate, useLocation } from "react-router-dom";
import { ReactNode, useState } from "react";
import {
  LayoutDashboard, Bot, PhoneCall, Users, Inbox, CalendarDays, Megaphone, Plug, Settings, Shield, LogOut, Menu, Phone, X,
  Building2, Activity, ArrowLeftRight, Wallet, Receipt, SlidersHorizontal, BookOpen, type LucideIcon,
} from "lucide-react";
import { useSession } from "../lib/session";
import { Loading } from "./ui";
import { SubscribeGate } from "../pages/Billing";

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };

const APP_NAV: NavItem[] = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/agents", label: "Agents", icon: Bot },
  { to: "/app/knowledge", label: "Knowledge", icon: BookOpen },
  { to: "/app/calls", label: "Calls", icon: PhoneCall },
  { to: "/app/leads", label: "Leads", icon: Inbox },
  { to: "/app/customers", label: "Customers", icon: Users },
  { to: "/app/bookings", label: "Bookings", icon: CalendarDays },
  { to: "/app/campaigns", label: "Campaigns", icon: Megaphone },
  { to: "/app/numbers", label: "Phone numbers", icon: Phone },
  { to: "/app/integrations", label: "Integrations", icon: Plug },
  { to: "/app/billing", label: "Billing", icon: Wallet },
  { to: "/app/settings", label: "Settings", icon: Settings },
];

const ADMIN_NAV: NavItem[] = [
  { to: "/admin", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/admin/customers", label: "Customers", icon: Building2 },
  { to: "/admin/payments", label: "Payments", icon: Receipt },
  { to: "/admin/settings", label: "Settings", icon: SlidersHorizontal },
  { to: "/admin/system", label: "System", icon: Activity },
];

export function Logo({ dark: _dark = false, small = false }: { dark?: boolean; small?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <img src="/pine.svg" alt="" className={small ? "h-6 w-6" : "h-8 w-8"} />
      <span className={`font-display ${small ? "text-lg" : "text-[22px]"} text-ink leading-none`}>Pine AI</span>
    </span>
  );
}

function NavList({ items, onPick }: { items: NavItem[]; onPick: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} onClick={onPick}
          className={({ isActive }) => `group flex items-center gap-3 rounded-xl px-3 h-10 text-sm transition-colors ${isActive ? "bg-white/[0.09] text-ink shadow-card" : "text-ink-mute hover:text-ink hover:bg-white/[0.04]"}`}>
          {({ isActive }) => (<><n.icon className={`h-4 w-4 ${isActive ? "text-leaf" : ""}`} /> {n.label}</>)}
        </NavLink>
      ))}
    </nav>
  );
}

/** The shared frame: a frosted sidebar and a "window" panel like the dashboard on the website. */
function Shell({ nav, top, footer, title, children }: { nav: NavItem[]; top?: ReactNode; footer?: ReactNode; title: string; children: ReactNode }) {
  const { me, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const who = me && (
    <div className="flex items-center gap-3 min-w-0">
      <div className="h-9 w-9 shrink-0 rounded-full bg-leaf-wash shadow-glow grid place-items-center font-display text-leaf">{(me.user.name || me.user.email).slice(0, 1).toUpperCase()}</div>
      <div className="min-w-0 text-xs">
        <div className="truncate text-ink-soft font-medium">{me.user.name || me.user.email.split("@")[0]}</div>
        <div className="truncate text-ink-mute">{me.user.email}</div>
      </div>
    </div>
  );
  const side = (
    <>
      <Logo />
      {top}
      <div className="flex-1 overflow-y-auto -mx-1 px-1">
        <NavList items={nav} onPick={() => setOpen(false)} />
        {footer}
      </div>
      <div className="border-t border-canvas-line pt-4 space-y-3">
        {who}
        <button className="btn-ghost btn-sm w-full justify-start" onClick={signOut}><LogOut className="h-3.5 w-3.5" /> Sign out</button>
      </div>
    </>
  );
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[260px_1fr]">
      <aside className="hidden lg:flex flex-col gap-6 p-5 sticky top-0 h-screen border-r border-canvas-line bg-black/20 backdrop-blur-xl">{side}</aside>
      <header className="lg:hidden sticky top-0 z-30 flex items-center justify-between border-b border-canvas-line bg-[#0B1409]/85 backdrop-blur px-4 h-14">
        <Logo small />
        <button className="btn-ghost btn-sm" onClick={() => setOpen(true)} aria-label="Menu"><Menu className="h-5 w-5" /></button>
      </header>
      {open && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/60" onClick={() => setOpen(false)}>
          <div className="absolute left-0 top-0 h-full w-72 bg-canvas-solid p-5 flex flex-col gap-6 shadow-lift" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-end -mb-4"><button className="btn-ghost btn-sm" onClick={() => setOpen(false)} aria-label="Close"><X className="h-4 w-4" /></button></div>
            {side}
          </div>
        </div>
      )}
      <main className="min-w-0 p-3 sm:p-5 lg:p-7">
        <div className="panel rounded-[22px] overflow-hidden max-w-[1360px] mx-auto">
          <div className="relative hidden sm:flex items-center justify-center h-12 border-b border-white/10">
            
            <span className="font-display text-[17px] text-ink">{title}</span>
          </div>
          <div className="px-4 py-6 sm:px-8 sm:py-8 lg:px-10">{children}</div>
        </div>
      </main>
    </div>
  );
}

export function AppLayout() {
  const { me, loading, switchOrg } = useSession();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  const current = me.orgs.find((o) => o.id === me.orgId);
  // Customers never pick a workspace; admins reach one from the admin panel.
  const orgPicker = me.orgs.length > 1 && !me.user.isPlatformAdmin ? (
    <div>
      <div className="eyebrow mb-2">Workspace</div>
      <select className="input h-10 text-sm" value={me.orgId} onChange={(e) => switchOrg(e.target.value)} aria-label="Workspace">
        {me.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  ) : null;
  const viewing = me.user.isPlatformAdmin && current ? (
    <div className="rounded-2xl card-roi px-4 py-3 text-xs text-ink-soft"><div className="eyebrow text-leaf/80">Viewing as admin</div><div className="mt-1 text-ink font-medium truncate">{current.name}</div></div>
  ) : orgPicker;
  const adminLink = me.user.isPlatformAdmin && (
    <NavLink to="/admin" className="mt-5 flex items-center gap-3 rounded-xl px-3 h-10 text-sm text-leaf bg-leaf-wash shadow-glow hover:brightness-110">
      <Shield className="h-4 w-4" /> Admin panel
    </NavLink>
  );
  return (
    <Shell nav={APP_NAV} top={viewing} footer={adminLink} title={current?.name ? `Pine AI · ${current.name}` : "Pine AI"}>
      {!me.orgId ? (
        <div className="py-16 text-center">
          <div className="font-display text-2xl text-ink">{me.user.isPlatformAdmin ? "Pick a customer" : "No workspace yet"}</div>
          <p className="text-sm text-ink-mute mt-2">
            {me.user.isPlatformAdmin ? <>Open a customer from the <NavLink className="text-leaf underline" to="/admin/customers">Admin panel</NavLink> to see their workspace.</> : "Your account is not part of a workspace yet. Ask your Pine AI contact to add you."}
          </p>
        </div>
      ) : me.billing?.suspended && !me.user.isPlatformAdmin ? (
        <div className="py-16 text-center"><div className="font-display text-2xl">Workspace suspended</div><p className="text-sm text-ink-mute mt-2">Please contact Pine AI.</p></div>
      ) : me.billing?.required && !me.user.isPlatformAdmin && !loc.pathname.startsWith("/app/billing") ? <SubscribeGate /> : <Outlet />}
    </Shell>
  );
}

export function AdminLayout() {
  const { me, loading } = useSession();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (!me.user.isPlatformAdmin) return <Navigate to="/app" replace />;
  const badge = (
    <div className="rounded-2xl card-roi px-4 py-3">
      <div className="eyebrow text-leaf/80">Admin panel</div>
      <div className="text-xs text-ink-soft mt-1">Every client, usage, billing and system health.</div>
    </div>
  );
  const toApp = (
    <NavLink to="/app" className="mt-5 flex items-center gap-3 rounded-xl px-3 h-10 text-sm text-ink-mute hover:text-ink hover:bg-white/[0.04]">
      <ArrowLeftRight className="h-4 w-4" /> Client workspace
    </NavLink>
  );
  return <Shell nav={ADMIN_NAV} top={badge} footer={toApp} title="Pine AI · Admin"><Outlet /></Shell>;
}
