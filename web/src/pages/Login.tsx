import { FormEvent, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../lib/api";
import { useSession } from "../lib/session";
import { Logo } from "../components/Layout";
import { ErrorNote } from "../components/ui";

export default function Login() {
  const { me } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const next = params.get("next")?.startsWith("/app") ? params.get("next")! : "/app";
  if (me) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/auth/login", { email, password });
      await qc.invalidateQueries({ queryKey: ["me"] });
      nav(next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-8 space-y-4">
        <Logo />
        <div>
          <h1 className="text-xl font-semibold">Welcome back</h1>
          <p className="text-sm text-ink-mute">Sign in to your Pine AI workspace.</p>
        </div>
        <label className="block"><span className="label">Email</span><input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="block"><span className="label">Password</span><input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <ErrorNote error={error} />
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}
