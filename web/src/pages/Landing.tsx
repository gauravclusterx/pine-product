import { Link } from "react-router-dom";
import { PhoneIncoming, PhoneOutgoing, Zap, BarChart3, Plug, CheckCircle2, ArrowRight } from "lucide-react";
import { Logo } from "../components/Layout";

/** Where "Talk to us" goes. Set VITE_CONTACT_URL at build time (mailto: or a booking link). */
const CONTACT = import.meta.env.VITE_CONTACT_URL || "mailto:hello@clusterx.ai";

const INDUSTRIES = ["HVAC", "Plumbing", "Roofing", "Solar", "Electrical", "Pest control", "Garage doors", "Cleaning"];

const PRODUCTS = [
  { icon: PhoneIncoming, title: "Inbound", body: "Answers every call, day or night, in your voice and with your rules — and books the job straight into your schedule." },
  { icon: Zap, title: "Speed to lead", body: "Calls every new lead from Google, Meta, Angi, Thumbtack, Yelp or your website within a minute, while they are still deciding." },
  { icon: PhoneOutgoing, title: "Campaigns", body: "Follows up open estimates, renews memberships and brings back past customers when the board looks thin." },
  { icon: BarChart3, title: "QA & coaching", body: "Scores every call, flags the jobs that slipped away and tells you exactly what to fix." },
  { icon: Plug, title: "Fits your stack", body: "ServiceTitan, Housecall Pro, Jobber, Salesforce, AccuLynx, Google Calendar, Outlook, Slack and SMS." },
];

function BookingCard() {
  return (
    <div className="card p-5 shadow-lift w-full max-w-sm">
      <div className="flex items-center justify-between text-xs text-ink-mute">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-leaf animate-pulse" /> Incoming call · 11:42 PM</span>
        <span>(212) 555-0142</span>
      </div>
      <div className="mt-4 space-y-2 text-sm">
        <div className="rounded-2xl rounded-tl-sm bg-canvas px-3 py-2 w-fit max-w-[85%]">My AC stopped blowing cold air.</div>
        <div className="rounded-2xl rounded-tr-sm bg-ink text-white px-3 py-2 w-fit max-w-[85%] ml-auto">I can have a technician there tomorrow between 2 and 4 PM. Shall I book it?</div>
        <div className="rounded-2xl rounded-tl-sm bg-canvas px-3 py-2 w-fit">Yes please.</div>
      </div>
      <div className="mt-4 rounded-xl border border-leaf/30 bg-leaf-wash p-3 text-sm">
        <div className="flex items-center gap-1.5 font-medium text-leaf-dark"><CheckCircle2 className="h-4 w-4" /> Job booked by Pine AI</div>
        <dl className="mt-2 grid grid-cols-2 gap-y-1 text-xs text-ink-soft">
          <dt className="text-ink-mute">Customer</dt><dd>Jordan Price</dd>
          <dt className="text-ink-mute">Job</dt><dd>AC repair · no cooling</dd>
          <dt className="text-ink-mute">Arrival</dt><dd>Tomorrow, 2–4 PM</dd>
          <dt className="text-ink-mute">Synced to</dt><dd>ServiceTitan</dd>
        </dl>
      </div>
    </div>
  );
}

export default function Landing() {
  return (
    <div className="bg-canvas">
      <header className="sticky top-0 z-30 border-b border-canvas-line/70 bg-canvas/85 backdrop-blur">
        <div className="mx-auto max-w-6xl flex items-center justify-between px-4 h-16">
          <Logo />
          <nav className="hidden md:flex items-center gap-7 text-sm text-ink-soft">
            <a href="#products" className="hover:text-ink">Products</a>
            <a href="#industries" className="hover:text-ink">Industries</a>
            <a href="#how" className="hover:text-ink">How it works</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link to="/login" className="btn-ghost">Log in</Link>
            <a href={CONTACT} className="btn-primary">Talk to us</a>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 pt-16 pb-20 grid lg:grid-cols-[1.15fr_1fr] gap-12 items-center">
        <div>
          <span className="chip bg-plum-wash text-plum">AI phone agents for home services</span>
          <h1 className="mt-5 text-5xl md:text-6xl font-semibold leading-[1.02]">
            Every call answered.<br />Every lead called.<br /><span className="text-leaf">Every job booked.</span>
          </h1>
          <p className="mt-6 text-lg text-ink-soft max-w-xl">
            Pine AI builds phone agents for your business — your script, your prices, your service area — connected to the software you already run.
            They pick up at 11 PM, call your Angi lead in under a minute, and put the job on your board.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href={CONTACT} className="btn-leaf h-12 px-6 text-base">Book a demo <ArrowRight className="h-4 w-4" /></a>
            <Link to="/login" className="btn-line h-12 px-6 text-base">Customer log in</Link>
          </div>
          <div className="mt-8 text-sm text-ink-mute">Runs on your number, your schedule system and your rules.</div>
        </div>
        <div className="flex justify-center lg:justify-end"><BookingCard /></div>
      </section>

      <section id="industries" className="border-y border-canvas-line bg-canvas-tint">
        <div className="mx-auto max-w-6xl px-4 py-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-sm font-medium text-ink-mute">
          {INDUSTRIES.map((i) => <span key={i}>{i}</span>)}
        </div>
      </section>

      <section id="products" className="mx-auto max-w-6xl px-4 py-20">
        <h2 className="text-3xl md:text-4xl font-semibold max-w-2xl">More than an answering service. A front office that never clocks out.</h2>
        <div className="mt-10 grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {PRODUCTS.map((p) => (
            <div key={p.title} className="card p-6 hover:shadow-lift transition-shadow">
              <div className="h-10 w-10 rounded-xl bg-leaf-wash flex items-center justify-center"><p.icon className="h-5 w-5 text-leaf-dark" /></div>
              <h3 className="mt-4 text-lg font-semibold">{p.title}</h3>
              <p className="mt-2 text-sm text-ink-soft">{p.body}</p>
            </div>
          ))}
          <div className="card p-6 bg-ink text-white border-ink">
            <h3 className="text-lg font-semibold">Made for your business — not off the shelf</h3>
            <p className="mt-2 text-sm text-white/70">Every agent starts from a proven playbook and is then built around how you work: emergencies, after-hours rules, who gets the transfer.</p>
          </div>
        </div>
      </section>

      <section id="how" className="bg-white border-y border-canvas-line">
        <div className="mx-auto max-w-6xl px-4 py-20 grid md:grid-cols-3 gap-8">
          {[
            ["1", "We learn your business", "Services, prices, area, hours, how you dispatch, which software you use."],
            ["2", "We build and test your agents", "Your script and rules, test calls with your team, then go live on your number."],
            ["3", "You watch the board fill", "Every call scored, every booking in your CRM, a daily summary in your inbox."],
          ].map(([n, t, b]) => (
            <div key={n}>
              <div className="h-9 w-9 rounded-full bg-plum-wash text-plum font-semibold flex items-center justify-center">{n}</div>
              <h3 className="mt-4 text-lg font-semibold">{t}</h3>
              <p className="mt-2 text-sm text-ink-soft">{b}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20">
        <div className="rounded-3xl bg-ink text-white p-10 md:p-14 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div>
            <h2 className="text-3xl font-semibold">Stop losing jobs to voicemail.</h2>
            <p className="mt-2 text-white/70">Live in days, not months. Bring your number, keep your CRM.</p>
          </div>
          <a href={CONTACT} className="btn-leaf h-12 px-6 text-base">Talk to us <ArrowRight className="h-4 w-4" /></a>
        </div>
      </section>

      <footer className="border-t border-canvas-line">
        <div className="mx-auto max-w-6xl px-4 py-8 flex flex-wrap items-center justify-between gap-4 text-sm text-ink-mute">
          <Logo />
          <span>© {new Date().getFullYear()} ClusterX AI Labs · Pine AI</span>
        </div>
      </footer>
    </div>
  );
}
