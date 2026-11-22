import { Navigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";
import { useSession } from "../lib/session";
import { Logo } from "../components/Layout";

const ERRORS: Record<string, string> = {
  not_allowed: "This Google account is not on Pine AI yet. Staff sign in with a clusterx.ai or rasen.ai account; clients use the email their Pine AI contact added.",
  not_verified: "Google did not confirm this email address. Try another account.",
  disabled: "This account has been switched off. Ask your Pine AI contact.",
  cancelled: "Sign-in was cancelled.",
  expired: "The sign-in took too long or was opened in another tab. Please try again.",
  google_failed: "Google sign-in did not complete. Please try again.",
  not_configured: "Google sign-in is not set up on this server yet.",
};

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[18px] w-[18px] shrink-0">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

export default function Login() {
  const { me } = useSession();
  const [params] = useSearchParams();
  const opts = useQuery({ queryKey: ["auth-options"], queryFn: () => get<{ google: boolean; domains: string[] }>("/auth/options"), retry: false });
  const next = params.get("next");
  if (me) return <Navigate to={next?.startsWith("/app") || next?.startsWith("/admin") ? next : me.user.isPlatformAdmin ? "/admin" : "/app"} replace />;
  const err = params.get("error");

  return (
    <div className="min-h-screen grid lg:grid-cols-[1fr_1.1fr]">
      <div className="flex flex-col justify-between p-6 sm:p-10">
        <a href="/"><Logo /></a>
        <div className="w-full max-w-sm mx-auto py-16">
          <p className="eyebrow">Welcome back</p>
          <h1 className="text-[44px] leading-[1.05] text-ink mt-3">Sign in to Pine&nbsp;AI</h1>
          <p className="text-ink-mute mt-3">Your AI front desk kept answering while you were away.</p>
          {err && <div className="mt-6 rounded-xl bg-bad-wash text-bad text-sm px-4 py-3 shadow-[inset_0_0_0_1px_rgba(242,164,155,0.25)]">{ERRORS[err] || "Sign-in failed. Please try again."}</div>}
          <a href="/api/auth/google" aria-disabled={opts.data?.google === false}
            className={`mt-8 flex h-12 w-full items-center justify-center gap-3 rounded-full bg-ink text-[#0B1409] font-medium transition hover:bg-white ${opts.data?.google === false ? "pointer-events-none opacity-50" : ""}`}>
            <GoogleMark /> Continue with Google
          </a>
          <p className="text-xs text-ink-mute mt-5 leading-relaxed">
            Pine AI staff use their {(opts.data?.domains || ["clusterx.ai", "rasen.ai"]).map((d) => `@${d}`).join(" or ")} Google account. Clients sign in with the Google account of the email their Pine AI contact added.
          </p>
        </div>
        <p className="text-xs text-ink-mute">By signing in you agree to the <a className="underline hover:text-ink" href="/terms">Terms</a> and <a className="underline hover:text-ink" href="/privacy">Privacy Policy</a>.</p>
      </div>

      <div className="hidden lg:flex items-center p-10">
        <div className="panel rounded-[22px] w-full max-w-xl mx-auto p-8">
          <p className="eyebrow">Booked tonight</p>
          <div className="num text-[52px] text-leaf-light mt-2">+$4,570</div>
          <div className="mt-6 space-y-3">
            {[["Burst pipe", "On-call tech paged", "+$1,850"], ["Water heater leak", "Booked Thu 8–10 am", "+$2,400"], ["Slow drain", "Called back in 11 s", "+$320"]].map(([t, s, v]) => (
              <div key={t} className="glass rounded-2xl px-4 py-3.5 flex items-center justify-between">
                <div><div className="text-ink font-medium">{t}</div><div className="text-[13px] text-leaf mt-0.5">✓ {s}</div></div>
                <div className="num text-2xl text-ink">{v}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-ink-mute mt-5">Illustrative example.</p>
        </div>
      </div>
    </div>
  );
}
