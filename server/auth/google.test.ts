import { describe, expect, it } from "vitest";
import { decideSignIn, emailDomain } from "./google.js";

const DOMAINS = ["clusterx.ai", "rasen.ai"];
const ADMINS = ["gaurav@clusterx.ai", "kailash@clusterx.ai"];
const g = (email: string, emailVerified = true) => ({ email, emailVerified });
const decide = (email: string, existing: { disabled: boolean } | null = null, verified = true) => decideSignIn(g(email, verified), existing, DOMAINS, ADMINS);

describe("Google sign-in policy", () => {
  it("makes only the listed emails admins", () => {
    expect(decide("gaurav@clusterx.ai")).toEqual({ ok: true, create: true, admin: true });
    expect(decide("Kailash@ClusterX.ai")).toEqual({ ok: true, create: true, admin: true });
  });

  it("signs other people on the allowed domains up as customers", () => {
    expect(decide("tejaswi@clusterx.ai")).toEqual({ ok: true, create: true, admin: false });
    expect(decide("ravi@rasen.ai")).toEqual({ ok: true, create: true, admin: false });
  });

  it("refuses an unknown person from any other domain, including look-alikes", () => {
    expect(decide("someone@gmail.com")).toEqual({ ok: false, reason: "not_allowed" });
    expect(decide("x@evilclusterx.ai")).toEqual({ ok: false, reason: "not_allowed" });
    expect(decide("x@clusterx.ai.evil.com")).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("lets a person an admin already added sign in whatever their domain", () => {
    expect(decide("owner@harborplumbing.com", { disabled: false })).toEqual({ ok: true, create: false, admin: false });
  });

  it("refuses unverified emails and disabled users", () => {
    expect(decide("tejaswi@clusterx.ai", null, false)).toEqual({ ok: false, reason: "not_verified" });
    expect(decide("tejaswi@clusterx.ai", { disabled: true })).toEqual({ ok: false, reason: "disabled" });
  });

  it("reads the domain of an email", () => {
    expect(emailDomain(" A@ClusterX.AI ")).toBe("clusterx.ai");
  });
});
