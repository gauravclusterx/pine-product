import { describe, expect, it } from "vitest";
import { decideSignIn, emailDomain } from "./google.js";

const DOMAINS = ["clusterx.ai", "rasen.ai"];
const g = (email: string, emailVerified = true) => ({ email, emailVerified });

describe("Google sign-in policy", () => {
  it("lets staff on an allowed domain in and creates their account", () => {
    expect(decideSignIn(g("asha@clusterx.ai"), null, DOMAINS)).toEqual({ ok: true, create: true, staff: true });
    expect(decideSignIn(g("Ravi@Rasen.ai"), null, DOMAINS)).toEqual({ ok: true, create: true, staff: true });
  });

  it("refuses an unknown person from any other domain", () => {
    expect(decideSignIn(g("someone@gmail.com"), null, DOMAINS)).toEqual({ ok: false, reason: "not_allowed" });
    // A look-alike domain is not the staff domain.
    expect(decideSignIn(g("x@evilclusterx.ai"), null, DOMAINS)).toEqual({ ok: false, reason: "not_allowed" });
    expect(decideSignIn(g("x@clusterx.ai.evil.com"), null, DOMAINS)).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("lets a person staff already added sign in whatever their domain, but not as staff", () => {
    expect(decideSignIn(g("owner@harborplumbing.com"), { disabled: false }, DOMAINS)).toEqual({ ok: true, create: false, staff: false });
  });

  it("refuses unverified emails and disabled users", () => {
    expect(decideSignIn(g("asha@clusterx.ai", false), null, DOMAINS)).toEqual({ ok: false, reason: "not_verified" });
    expect(decideSignIn(g("asha@clusterx.ai"), { disabled: true }, DOMAINS)).toEqual({ ok: false, reason: "disabled" });
  });

  it("reads the domain of an email", () => {
    expect(emailDomain(" A@ClusterX.AI ")).toBe("clusterx.ai");
  });
});
