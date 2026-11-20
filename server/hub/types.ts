/**
 * The Integration Hub contract.
 *
 * An agent never talks to a client's software directly. It calls a small set of standard tools
 * (hub/service.ts); the org's connector translates them for whichever system the client runs.
 * Adding a CRM = writing one file that implements `CrmConnector`.
 */
import type { Org } from "../modules/orgs.js";

/** A minimal HTTP function, injected so connectors are testable without the network. */
export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body, or a string for form-encoded bodies (set the content-type header). */
  body?: unknown;
  timeoutMs?: number;
}
export interface HttpResponse { status: number; data: any; headers: Record<string, string> }
export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export interface ConnectorContext {
  org: Org;
  /** Decrypted credentials of the integration (shape is per connector). */
  credentials: Record<string, any>;
  /** Non-secret settings of the integration (ids, mappings). */
  settings: Record<string, any>;
  http: HttpFn;
  /** Persist rotated credentials (a refresh token that changes on every use). */
  saveCredentials(patch: Record<string, any>): Promise<void>;
  /** Per-integration cache for tokens and reference data (job types, technicians). */
  cache: { get<T>(key: string): T | undefined; set<T>(key: string, value: T, ttlSeconds: number): void };
}

export interface Address { street?: string; city?: string; state?: string; postalCode?: string }

export interface ExternalCustomer {
  externalId: string;
  name: string;
  phone: string;
  email?: string;
  address?: Address;
  notes?: string;
}

export interface Slot { start: Date; end: Date }

export interface AvailabilityQuery { from: Date; to: Date; jobType: string; postalCode?: string; durationMinutes: number }

export interface BookJobInput {
  externalCustomerId?: string | null;
  customer: { name: string; phone: string; email?: string; address?: Address };
  jobType: string;
  start: Date;
  end: Date;
  notes?: string;
  /** Lead source to attribute the job to in the client's system, when it tracks that. */
  source?: string;
  idempotencyKey: string;
}

export interface BookJobResult { externalJobId: string; externalCustomerId: string }

export interface Estimate { externalId: string; title: string; amountCents: number; status: string; createdAt?: string }
export interface Membership { externalId: string; name: string; status: string; expiresAt?: string }

export interface CredentialField { key: string; label: string; secret?: boolean; required?: boolean; help?: string }

export interface CrmConnector {
  kind: string;
  label: string;
  /**
   * How far this connector has been proven:
   *  - "live"       exercised end to end (the built-in calendar).
   *  - "unverified" written against the vendor's published API and covered by tests that replay
   *                 that API's documented shapes, but not yet run against a real account. Expect
   *                 small fixes on first contact.
   */
  maturity: "live" | "unverified";
  /** What the client has to give us, and any approval they or we need first. */
  credentialFields: CredentialField[];
  settingFields?: CredentialField[];
  accessNote?: string;
  /** Cheap authenticated call that proves the credentials work. Throws with a readable message. */
  test(ctx: ConnectorContext): Promise<void>;
  lookupCustomer(ctx: ConnectorContext, phoneE164: string): Promise<ExternalCustomer | null>;
  /** Open arrival windows. Not every system exposes capacity: return null to use business hours. */
  getAvailability(ctx: ConnectorContext, query: AvailabilityQuery): Promise<Slot[] | null>;
  bookJob(ctx: ConnectorContext, input: BookJobInput): Promise<BookJobResult>;
  reschedule(ctx: ConnectorContext, input: { externalJobId: string; start: Date; end: Date }): Promise<void>;
  cancel(ctx: ConnectorContext, input: { externalJobId: string; reason?: string }): Promise<void>;
  createLead(ctx: ConnectorContext, input: { customer: BookJobInput["customer"]; summary: string; source?: string }): Promise<{ externalId: string }>;
  getEstimates(ctx: ConnectorContext, externalCustomerId: string): Promise<Estimate[]>;
  getMembership(ctx: ConnectorContext, externalCustomerId: string): Promise<Membership | null>;
}

/** A failure a connector wants shown to staff verbatim (bad credentials, plan without API…). */
export class ConnectorError extends Error {
  retryable: boolean;
  constructor(message: string, opts: { retryable?: boolean } = {}) {
    super(message);
    this.name = "ConnectorError";
    this.retryable = opts.retryable ?? false;
  }
}

/** Throw a ConnectorError for a non-2xx answer, keeping the vendor's own message. */
export function expectOk(res: HttpResponse, what: string): any {
  if (res.status >= 200 && res.status < 300) return res.data;
  const detail = typeof res.data === "string" ? res.data : res.data?.message || res.data?.error_description || res.data?.error?.message || res.data?.title || JSON.stringify(res.data ?? "");
  const msg = `${what} failed (${res.status})${detail ? ": " + String(detail).slice(0, 300) : ""}`;
  if (res.status === 401 || res.status === 403) throw new ConnectorError(`${msg} — check the credentials and that API access is enabled.`);
  throw new ConnectorError(msg, { retryable: res.status === 429 || res.status >= 500 });
}

export function splitName(full: string): { first: string; last: string } {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

/** The last ten digits — how most CRMs index a North American number. */
export function national10(e164: string): string {
  return String(e164 || "").replace(/\D/g, "").slice(-10);
}
