import { createContext, ReactNode, useContext } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, currentOrgId, get, post, setCurrentOrgId } from "./api";

export interface Me {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  orgId: string;
  role: "owner" | "manager" | "viewer";
  orgs: Array<{ id: string; name: string; slug: string; role: string }>;
  billing: Billing | null;
}

export interface Billing {
  status: "inactive" | "trial" | "active" | "expired";
  active: boolean;
  suspended: boolean;
  expiresAt: string | null;
  trialEndsAt: string | null;
  trialUsed: boolean;
  price: number;
  currency: "INR" | "USD" | "GBP";
  voicePerUnit: number;
  chatPerUnit: number;
  taxPercent: number;
  wallet: { voice: number; chat: number };
  paywallEnabled: boolean;
  required: boolean;
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  can: (role: "viewer" | "manager" | "owner") => boolean;
  switchOrg: (id: string) => void;
  signOut: () => Promise<void>;
  refresh: () => void;
}

const Ctx = createContext<SessionValue | null>(null);
const RANK = { viewer: 1, manager: 2, owner: 3 } as const;

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const me = await get<Me>("/auth/me");
        if (me.orgId && me.orgId !== currentOrgId()) setCurrentOrgId(me.orgId);
        return me;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          // A remembered org we no longer have: forget it and ask again.
          if (e.status === 403 && currentOrgId()) { setCurrentOrgId(""); return get<Me>("/auth/me").catch(() => null); }
          return null;
        }
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
  const me = data ?? null;
  const value: SessionValue = {
    me,
    loading: isLoading,
    can: (role) => !!me && (me.user.isPlatformAdmin || RANK[me.role] >= RANK[role]),
    switchOrg: (id) => { setCurrentOrgId(id); qc.clear(); qc.invalidateQueries(); },
    signOut: async () => { await post("/auth/logout").catch(() => {}); setCurrentOrgId(""); qc.clear(); window.location.href = "/login"; },
    refresh: () => qc.invalidateQueries({ queryKey: ["me"] }),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}
