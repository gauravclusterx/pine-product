/**
 * Local demo data, so the app can be explored without a voice workspace. Creates a platform
 * admin and one clearly-labelled demo client with sample customers, calls, bookings and leads.
 * Refuses to run in production.
 *
 *   npm run seed           (uses DATABASE_URL, or the embedded development database)
 */
import { config } from "../config.js";
import { closeDb, initDb, one, q } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { hashPassword } from "../auth/auth.js";
import { createOrg, updateOrg } from "../modules/orgs.js";
import { upsertCustomer } from "../modules/customers.js";
import { scoreCall } from "../modules/qa.js";

if (config.NODE_ENV === "production") { console.error("seed-demo refuses to run in production"); process.exit(1); }

const ADMIN = process.env.PLATFORM_ADMIN_EMAIL || "admin@pine.local";
const PASSWORD = process.env.PLATFORM_ADMIN_PASSWORD || "PineDemo2026";

const PEOPLE = [
  ["Jordan Price", "+12125550142", "10001"], ["Maria Santos", "+12125550178", "10002"], ["Sam Lee", "+12125550111", "10003"],
  ["Priya Nair", "+12125550133", "11215"], ["Chris Walker", "+12125550164", "10001"], ["Dana Brooks", "+12125550190", "11201"],
  ["Luis Ortega", "+12125550121", "10011"], ["Ava Chen", "+12125550155", "10013"],
];
const SCRIPTS: Array<{ outcome: string; summary: string; lines: string[]; secs: number }> = [
  { outcome: "booked", secs: 186, summary: "AC not cooling; booked AC repair tomorrow 10–12.", lines: ["AI: Thanks for calling Summit Heating & Air, this is Ava. How can I help you today?", "Customer: Our AC stopped blowing cold air last night.", "AI: I'm sorry to hear that. Is anyone at home unwell from the heat?", "Customer: No, we're fine, just hot.", "AI: I have tomorrow between 10 and 12, or 2 to 4. Which works better?", "Customer: Ten to twelve please.", "AI: You're booked for tomorrow, 10 to 12. You'll get a text confirmation. Thanks for calling!"] },
  { outcome: "callback", secs: 74, summary: "Wants a quote for a new furnace; call back Thursday afternoon.", lines: ["AI: Hi, this is Ava calling from Summit Heating & Air about your request for a furnace quote. Is now a good moment?", "Customer: Not really, can you call Thursday afternoon?", "AI: Of course. I'll have us call you Thursday afternoon. Thank you!"] },
  { outcome: "no_contact", secs: 0, summary: "", lines: [] },
  { outcome: "booked", secs: 212, summary: "Annual tune-up booked; member discount applied.", lines: ["AI: Thanks for calling Summit Heating & Air, this is Ava. How can I help?", "Customer: I want to book my yearly tune-up.", "AI: Happy to. I see you're a Comfort Club member, so the tune-up is included. Does Monday 8 to 10 work?", "Customer: Perfect.", "AI: Booked for Monday 8 to 10. Thank you, have a great day!"] },
  { outcome: "info", secs: 58, summary: "Asked about opening hours on Saturday.", lines: ["AI: Thanks for calling Summit Heating & Air, this is Ava.", "Customer: Are you open Saturdays?", "AI: We're closed on Saturdays, but emergencies are answered around the clock. Anything else?", "Customer: No, thanks."] },
  { outcome: "unknown", secs: 140, summary: "Water heater leaking; caller hung up before booking.", lines: ["AI: Thanks for calling Summit Heating & Air, this is Ava.", "Customer: My water heater is leaking, can someone come today?", "AI: Let me check today's openings.", "Customer: Actually I'll call back."] },
];

async function main() {
  await initDb();
  await migrate();
  let admin = await one("SELECT id FROM users WHERE lower(email) = lower($1)", [ADMIN]);
  if (!admin) admin = await one("INSERT INTO users (email, name, password_hash, is_platform_admin) VALUES ($1, 'Pine admin', $2, true) RETURNING id", [ADMIN, await hashPassword(PASSWORD)]);
  if (await one("SELECT 1 AS x FROM orgs WHERE name LIKE 'Demo — %'")) { console.log("demo data already present"); return; }

  const org = await createOrg({ name: "Demo — Summit Heating & Air", industry: "hvac", timezone: "America/New_York", rateCentsPerMinute: 25 });
  await updateOrg(org.id, { settings: {
    services: [{ name: "AC repair", durationMinutes: 120, valueCents: 38500 }, { name: "Furnace repair", durationMinutes: 120, valueCents: 42000 }, { name: "Tune-up", durationMinutes: 90, valueCents: 12900 }, { name: "Water heater", durationMinutes: 120, valueCents: 65000 }],
    serviceAreas: ["100*", "112*"], transferNumber: "+12125550100", slotCapacity: 2,
  } });
  await q("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [org.id, admin!.id]);
  const agents = [];
  for (const [name, playbook] of [["Ava", "inbound_booking"], ["Max", "speed_to_lead"], ["Rae", "estimate_followup"]]) {
    agents.push((await one("INSERT INTO agents (org_id, name, playbook, status, config, provider_agent_id, published_at) VALUES ($1, $2, $3, 'live', '{}', $4, now() - interval '9 days') RETURNING id", [org.id, name, playbook, `demo_${playbook}`]))!.id);
  }
  const now = Date.now();
  const sources = ["google_lsa", "angi", "meta", "web_form", "thumbtack", "yelp"];
  let n = 0;
  for (let day = 20; day >= 0; day--) {
    const perDay = 3 + ((day * 7) % 5);
    for (let k = 0; k < perDay; k++) {
      const [name, phone, zip] = PEOPLE[(day + k) % PEOPLE.length];
      const c = await upsertCustomer(org.id, { phone, name, address: { postalCode: zip }, consentAt: new Date(now - 30 * 86_400_000), consentSource: "web_form" });
      const s = SCRIPTS[(day * 3 + k) % SCRIPTS.length];
      const started = new Date(now - day * 86_400_000 - (9 + k * 2) * 3_600_000);
      const inbound = k % 3 !== 1;
      let leadId: string | null = null;
      if (!inbound) {
        leadId = (await one(
          "INSERT INTO leads (org_id, source, source_ref, customer_id, name, phone_e164, service, postal_code, status, received_at, first_call_at, attempts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1) RETURNING id",
          [org.id, sources[n % sources.length], `demo-${n}`, c.id, name, phone, "AC repair", zip, s.outcome === "booked" ? "booked" : s.outcome === "no_contact" ? "queued" : "contacted", new Date(started.getTime() - 40_000), started]
        ))!.id;
      }
      const qa = scoreCall({ transcript: s.lines.join("\n"), outcome: s.outcome, extraction: { sentiment: "positive" }, durationSeconds: s.secs, businessName: "Summit Heating & Air" });
      const call = (await one(
        `INSERT INTO calls (org_id, provider_call_id, agent_id, direction, customer_id, lead_id, phone_e164, status, ended_reason, started_at, ended_at, duration_seconds, billable_seconds, charge_cents,
           transcript, summary, extraction, outcome, qa_score, qa, results_final, recording_available)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'ended',$8,$9,$10,$11,$11,$12,$13,$14,$15,$16,$17,$18,true,false) RETURNING id`,
        [org.id, `demo_call_${n}`, agents[inbound ? 0 : 1], inbound ? "inbound" : "outbound", c.id, leadId, phone, s.secs ? "customer_hangup" : "no_answer", started, new Date(started.getTime() + s.secs * 1000),
          s.secs, s.secs ? Math.ceil(s.secs / 60) * 25 : 0, JSON.stringify(s.lines), s.summary, JSON.stringify({ outcome: s.outcome }), s.outcome, qa?.score ?? null, JSON.stringify(qa || { skipped: "no conversation" })]
      ))!.id;
      if (s.outcome === "booked") {
        const start = new Date(started.getTime() + 86_400_000);
        start.setUTCMinutes(0, 0, 0);
        await q("INSERT INTO bookings (org_id, call_id, customer_id, lead_id, connector, job_type, starts_at, ends_at, value_cents, idempotency_key, created_at) VALUES ($1,$2,$3,$4,'native','AC repair',$5,$6,38500,$7,$8)",
          [org.id, call, c.id, leadId, start, new Date(start.getTime() + 2 * 3_600_000), `demo-${n}`, started]);
      }
      n++;
    }
  }
  await q("INSERT INTO audit_log (org_id, action, detail) VALUES ($1, 'team.alert', $2)", [org.id, JSON.stringify({ kind: "new_booking", text: "✅ New booking: Jordan Price — AC repair, tomorrow 10:00–12:00." })]);
  console.log(`demo client created with ${n} calls`);
}

main()
  .then(() => { console.log(`sign in: ${ADMIN} / ${process.env.PLATFORM_ADMIN_PASSWORD ? "(PLATFORM_ADMIN_PASSWORD)" : PASSWORD}`); return closeDb(); })
  .catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
