/**
 * Orgs (client businesses) and their business rules. The rules are what makes each client's
 * agents and lead handling theirs: hours, service area, services and prices, calling window.
 */
import { z } from "zod";
import { one, q, Q } from "../db/pool.js";
import { notFound } from "../lib/errors.js";
import { DEFAULT_WEEK_HOURS, isValidTimeZone, parseWeekHours, WeekHours } from "../lib/time.js";

export const INDUSTRIES = ["hvac", "plumbing", "roofing", "solar", "electrical", "pest_control", "garage_door", "cleaning", "other"] as const;

const dayHours = z.object({ open: z.number().int().min(0).max(1439), close: z.number().int().min(1).max(1440) })
  .refine((d) => d.open < d.close, "opening time must be before closing time").nullable();

export const serviceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  durationMinutes: z.number().int().min(15).max(480).default(120),
  /** Typical ticket, in cents — used to estimate revenue booked. */
  valueCents: z.number().int().min(0).max(100_000_00).default(0),
});

export const settingsSchema = z.object({
  /** Country code added to national phone numbers (digits only). */
  defaultCountryCode: z.string().regex(/^\d{1,3}$/).default("1"),
  businessHours: z.array(dayHours).length(7).default(DEFAULT_WEEK_HOURS as any),
  /** Postal codes (or prefixes ending in *) the business serves. Empty = everywhere. */
  serviceAreas: z.array(z.string().trim().min(1).max(12)).max(2000).default([]),
  services: z.array(serviceSchema).max(100).default([]),
  /** Length of an arrival window, how many jobs fit in one, and how far ahead to offer. */
  slotMinutes: z.number().int().min(30).max(480).default(120),
  slotCapacity: z.number().int().min(1).max(50).default(2),
  bookingHorizonDays: z.number().int().min(1).max(60).default(14),
  /** Outbound calls are only started inside this local-time window. */
  callingWindow: z.object({ opens: z.number().int().min(0).max(1439), closes: z.number().int().min(1).max(1440) })
    .refine((w) => w.opens < w.closes, "window must open before it closes")
    // TCPA: no calls before 8:00 or after 21:00 local time.
    .refine((w) => w.opens >= 480 && w.closes <= 1260, "calling window must stay within 8:00–21:00")
    .default({ opens: 540, closes: 1200 }),
  speedToLead: z.object({
    enabled: z.boolean().default(false),
    agentId: z.string().uuid().nullable().default(null),
    /** A different agent for leads from one source (e.g. Angi leads → "Max"). Falls back to agentId. */
    agentBySource: z.record(z.string(), z.string().uuid()).default({}),
    maxAttempts: z.number().int().min(1).max(6).default(3),
    /** Minutes to wait before the 2nd, 3rd… attempt when the lead does not pick up. */
    retryMinutes: z.array(z.number().int().min(1).max(2880)).max(5).default([10, 120]),
    /** Leads must have given consent to be called for an automated call to be placed. */
    requireConsent: z.boolean().default(true),
  }).prefault({}),
  /** Which connector holds customers and the schedule. */
  crm: z.enum(["native", "servicetitan", "housecall_pro", "jobber", "salesforce", "acculynx", "generic_rest", "google_calendar", "outlook"]).default("native"),
  /** Where the agent transfers a caller who needs a person. */
  transferNumber: z.string().max(20).default(""),
  /** Outbound caller id: a phone number id or E.164 ("" = the agent's own number). */
  outboundNumber: z.string().max(40).default(""),
  /** SMS agent: AI replies to customers who text the business number (1 message credit per reply). */
  smsAgent: z.object({
    enabled: z.boolean().default(false),
    /** What the agent should know or do, in the owner's words. */
    instructions: z.string().max(4000).default(""),
  }).prefault({}),
});

export type OrgSettings = z.infer<typeof settingsSchema>;

export interface Org {
  id: string; name: string; slug: string; industry: string; timezone: string; status: string;
  rateCentsPerMinute: number; settings: OrgSettings; createdAt: Date;
}

/** Stored settings are parsed on every read, so a row written by an older version still loads. */
export function parseSettings(raw: unknown): OrgSettings {
  const r = settingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : settingsSchema.parse({});
}

function toOrg(row: any): Org {
  return {
    id: row.id, name: row.name, slug: row.slug, industry: row.industry, timezone: row.timezone, status: row.status,
    rateCentsPerMinute: row.rate_cents_per_minute, settings: parseSettings(row.settings), createdAt: row.created_at,
  };
}

export async function getOrg(orgId: string, run: Q = q): Promise<Org> {
  const rows = await run("SELECT * FROM orgs WHERE id = $1", [orgId]);
  if (!rows[0]) throw notFound("Workspace not found.");
  return toOrg(rows[0]);
}

export async function findOrg(orgId: string): Promise<Org | null> {
  const row = await one("SELECT * FROM orgs WHERE id = $1", [orgId]);
  return row ? toOrg(row) : null;
}

/** The agent that calls a lead from this source: the source's own agent, else the default. */
export function leadAgentFor(settings: OrgSettings, source: string): string | null {
  return settings.speedToLead.agentBySource[source] || settings.speedToLead.agentId || null;
}

export function businessHoursOf(org: Org): WeekHours {
  return parseWeekHours(org.settings.businessHours);
}

/** True when the postal code is inside the service area (or no area is configured). */
export function servesPostalCode(settings: OrgSettings, postalCode: string): boolean {
  const areas = settings.serviceAreas;
  if (!areas.length) return true;
  const pc = String(postalCode || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!pc) return false;
  return areas.some((a) => {
    const area = a.toUpperCase().replace(/\s+/g, "");
    return area.endsWith("*") ? pc.startsWith(area.slice(0, -1)) : pc === area || pc.slice(0, 5) === area;
  });
}

export function slugify(name: string): string {
  return String(name).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 48) || "org";
}

export const createOrgSchema = z.object({
  name: z.string().trim().min(2).max(120),
  industry: z.enum(INDUSTRIES).default("hvac"),
  timezone: z.string().refine(isValidTimeZone, "unknown time zone").default("America/New_York"),
  rateCentsPerMinute: z.number().int().min(0).max(10_000).default(25),
});

export async function createOrg(input: z.infer<typeof createOrgSchema>): Promise<Org> {
  const base = slugify(input.name);
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const rows = await q(
      `INSERT INTO orgs (name, slug, industry, timezone, rate_cents_per_minute, settings)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (slug) DO NOTHING RETURNING *`,
      [input.name, slug, input.industry, input.timezone, input.rateCentsPerMinute, JSON.stringify(settingsSchema.parse({}))]
    );
    if (rows[0]) return toOrg(rows[0]);
  }
  throw new Error("could not allocate a workspace slug");
}

export const updateOrgSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  industry: z.enum(INDUSTRIES).optional(),
  timezone: z.string().refine(isValidTimeZone, "unknown time zone").optional(),
  settings: settingsSchema.partial().optional(),
});

/** Update profile and/or merge a partial settings object. The merged settings are re-validated. */
export async function updateOrg(orgId: string, patch: z.infer<typeof updateOrgSchema>): Promise<Org> {
  const cur = await getOrg(orgId);
  const settings = patch.settings ? settingsSchema.parse({ ...cur.settings, ...patch.settings }) : cur.settings;
  const rows = await q(
    "UPDATE orgs SET name = $2, industry = $3, timezone = $4, settings = $5, updated_at = now() WHERE id = $1 RETURNING *",
    [orgId, patch.name ?? cur.name, patch.industry ?? cur.industry, patch.timezone ?? cur.timezone, JSON.stringify(settings)]
  );
  return toOrg(rows[0]);
}
