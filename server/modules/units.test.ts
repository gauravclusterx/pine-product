import { describe, expect, it } from "vitest";
import { settingsSchema, servesPostalCode, leadAgentFor, type Org } from "./orgs.js";
import { providerConfig, toolSpecs, toolsFor, agentConfigSchema } from "./agents.js";
import { scoreCall, parseTranscript } from "./qa.js";
import { chargeFor, outcomeOf } from "./calls.js";
import { fromAngi, fromThumbtack, fromWebForm, metaLeadIds, parseLeadEmail, verifyMetaSignature, fromLsaRow } from "../intake/sources.js";
import { createHmac } from "crypto";
import { toE164 } from "../lib/phone.js";

const org: Org = {
  id: "3f2b8c1e-5d4a-4b6e-9c7d-1a2b3c4d5e6f", name: "Acme Heating & Air", slug: "acme", industry: "hvac", timezone: "America/New_York", status: "active",
  rateCentsPerMinute: 25, createdAt: new Date(),
  settings: settingsSchema.parse({ services: [{ name: "AC repair", valueCents: 35000 }], serviceAreas: ["10001", "112*"], transferNumber: "(212) 555-0100" }),
};

describe("agent projection", () => {
  it("builds the prompt from the playbook and the client's facts", () => {
    const cfg = providerConfig(org, { name: "Ava", playbook: "inbound_booking", config: agentConfigSchema.parse({ brief: "Always mention the $89 tune-up special." }) });
    expect(cfg.systemPrompt).toMatch(/You are Ava, the AI phone assistant of Acme Heating & Air/);
    expect(cfg.systemPrompt).toMatch(/Monday: 8 AM–5 PM/);
    expect(cfg.systemPrompt).toMatch(/AC repair \(typical ticket \$350\)/);
    expect(cfg.systemPrompt).toMatch(/\$89 tune-up special/);
    // Inbound: the caller name from the before-call lookup, "there" when unknown.
    expect(cfg.firstMessage).toBe("Hi {{lookup_customer.name|there}}, thanks for calling Acme Heating & Air, this is Ava. How can I help you today?");
    expect(cfg.transferNumber).toBe("+12125550100");
    expect(cfg.callDirection).toBe("inbound");
    expect(cfg.extractionFields!.map((f) => f.name)).toContain("outcome");
  });
  it("outbound playbooks greet as a caller and detect voicemail", () => {
    const cfg = providerConfig(org, { name: "Ava", playbook: "speed_to_lead", config: agentConfigSchema.parse({}) });
    expect(cfg.callDirection).toBe("outbound");
    expect(cfg.voicemailDetection).toBe(true);
    expect(cfg.firstMessage).toBe("Hi {{greeting_name}}, this is Ava calling from Acme Heating & Air. Is now a good moment?");
  });
  it("a prompt override replaces the generated prompt", () => {
    const cfg = providerConfig(org, { name: "Ava", playbook: "custom", config: agentConfigSchema.parse({ promptOverride: "Only this." }) });
    expect(cfg.systemPrompt).toBe("Only this.");
  });
  it("tools carry the org's secret, the agent id, and the caller's number", () => {
    const specs = toolSpecs(org.id, "agent_x", "s3cret", toolsFor("inbound_booking"));
    expect(specs.map((s) => s.name)).toEqual(expect.arrayContaining(["lookup_customer", "get_availability", "book_job", "cancel_job", "notify_team"]));
    const lookup = specs.find((s) => s.name === "lookup_customer")!;
    expect(lookup.timing).toBe("pre_call");
    expect(lookup.parameters!.find((p) => p.name === "phone")).toMatchObject({ source: "dynamic_variable", value: "system__caller_id" });
    const book = specs.find((s) => s.name === "book_job")!;
    expect(book.url).toBe(`https://pine.test/api/tools/${org.id}/book_job`);
    expect(book.secretHeader).toEqual({ name: "x-pine-tool-secret", value: "s3cret" });
    expect(book.parameters!.find((p) => p.name === "agent_id")).toMatchObject({ source: "constant", value: "agent_x" });
    // Outbound agents cannot have a before-call tool.
    expect(toolsFor("speed_to_lead")).not.toContain("lookup_customer");
  });
});

describe("who calls, and what they call the customer", () => {
  it("a lead source can have its own agent; others use the default", () => {
    const s = settingsSchema.parse({ speedToLead: { agentId: "3f2b8c1e-5d4a-4b6e-9c7d-1a2b3c4d5e6f", agentBySource: { angi: "7a1c9e2d-4b3f-4e8a-8d6c-0f1e2d3c4b5a" } } });
    expect(leadAgentFor(s, "angi")).toBe("7a1c9e2d-4b3f-4e8a-8d6c-0f1e2d3c4b5a");
    expect(leadAgentFor(s, "meta")).toBe("3f2b8c1e-5d4a-4b6e-9c7d-1a2b3c4d5e6f");
    expect(leadAgentFor(settingsSchema.parse({}), "meta")).toBeNull();
  });
  it("the greeting name is the first name on file, or 'there'", async () => {
    const { memoryVariables } = await import("./customers.js");
    // memoryVariables reads the database only for a known customer; an unknown caller needs none.
    expect((await memoryVariables(org, null)).greeting_name).toBe("there");
  });
});

describe("rules", () => {
  it("service area: exact codes, ZIP+4, and prefixes", () => {
    expect(servesPostalCode(org.settings, "10001")).toBe(true);
    expect(servesPostalCode(org.settings, "10001-1234")).toBe(true);
    expect(servesPostalCode(org.settings, "11215")).toBe(true);
    expect(servesPostalCode(org.settings, "94105")).toBe(false);
    expect(servesPostalCode(org.settings, "")).toBe(false);
  });
  it("calling window must stay inside 8:00–21:00", () => {
    expect(settingsSchema.safeParse({ callingWindow: { opens: 420, closes: 1200 } }).success).toBe(false);
    expect(settingsSchema.safeParse({ callingWindow: { opens: 540, closes: 1320 } }).success).toBe(false);
    expect(settingsSchema.safeParse({ callingWindow: { opens: 540, closes: 1200 } }).success).toBe(true);
  });
  it("phone numbers normalise to E.164 and junk is refused", () => {
    expect(toE164("(212) 555-0142")).toBe("+12125550142");
    expect(toE164("+1 212 555 0142 ext 22")).toBe("+12125550142");
    expect(toE164("9113166099", "91")).toBe("+919113166099");
    expect(toE164("0091 98697 24812", "1")).toBe("+919869724812");
    expect(toE164("555-0142")).toBe("");
    expect(toE164("(012) 555-0142")).toBe("");
  });
  it("billing rounds up to whole minutes and never charges an unanswered call", () => {
    expect(chargeFor(0, 25)).toBe(0);
    expect(chargeFor(1, 25)).toBe(25);
    expect(chargeFor(60, 25)).toBe(25);
    expect(chargeFor(61, 25)).toBe(50);
  });
  it("outcome comes from the extraction, else from how the call ended", () => {
    const base: any = { status: "ended", extracted_data: null, ended_reason: "no_answer" };
    expect(outcomeOf(base)).toBe("no_contact");
    expect(outcomeOf({ ...base, ended_reason: "transferred" })).toBe("transferred");
    expect(outcomeOf({ ...base, extracted_data: { outcome: "booked" } })).toBe("booked");
    expect(outcomeOf({ ...base, extracted_data: { outcome: "booked", opted_out: true } })).toBe("opt_out");
    expect(outcomeOf({ ...base, ended_reason: "customer_hangup" })).toBe("unknown");
  });
});

describe("call scoring", () => {
  const good = "AI: Thanks for calling Acme Heating, this is Ava. How can I help?\nCustomer: My AC is not cooling, can someone come tomorrow?\nAI: I have tomorrow at 10 AM. Does that work?\nCustomer: Yes.\nAI: Booked. Thank you, have a great day!";
  it("a clean booking call scores high", () => {
    const r = scoreCall({ transcript: good, outcome: "booked", extraction: { sentiment: "positive" }, durationSeconds: 90, businessName: "Acme Heating" })!;
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.secondChance).toBe(false);
  });
  it("an interested caller with nothing booked is a second chance", () => {
    const r = scoreCall({ transcript: good, outcome: "unknown", extraction: {}, durationSeconds: 90, businessName: "Acme Heating" })!;
    expect(r.secondChance).toBe(true);
    expect(r.flags).toContain("missed_booking");
    expect(r.score).toBeLessThan(70);
  });
  it("an agent stuck repeating itself is flagged (the 20 Nov test call)", () => {
    const stuck = "AI: Hi from Acme Heating.\nCustomer: I want to book a meeting.\n" + Array.from({ length: 4 }, () => "AI: I'm sorry, I didn't catch that. Could you say the date and time once more, please?\nCustomer: Twenty-first November five PM.").join("\n");
    const r = scoreCall({ transcript: stuck, outcome: "unknown", extraction: {}, durationSeconds: 180, businessName: "Acme Heating" })!;
    expect(r.flags).toContain("repeated_questions");
  });
  it("nothing to score when nobody answered", () => {
    expect(scoreCall({ transcript: "AI: Hello?", outcome: "no_contact", extraction: {}, durationSeconds: 5, businessName: "Acme" })).toBeNull();
    expect(parseTranscript("AI: a\nCustomer: b\ncontinued")).toEqual([{ speaker: "AI", text: "a" }, { speaker: "Customer", text: "b continued" }]);
  });
});

describe("lead sources", () => {
  it("Angi, Thumbtack and web forms map to one shape", () => {
    expect(fromAngi({ leadOid: "123", firstName: "Maria", lastName: "Santos", primaryPhone: "2125550142", taskName: "AC Repair", postalCode: "10001", comments: "warm air" }))
      .toMatchObject({ source: "angi", sourceRef: "123", name: "Maria Santos", phone: "2125550142", service: "AC Repair", postalCode: "10001", consent: true });
    expect(fromThumbtack({ lead: { leadID: "tt-9", customer: { name: "Sam Lee", phone: "2125550111" }, request: { category: "Plumbing", location: { zipCode: "10001" } } } }))
      .toMatchObject({ source: "thumbtack", sourceRef: "tt-9", name: "Sam Lee", service: "Plumbing", postalCode: "10001" });
    expect(fromWebForm({ id: "f1", name: "Ana", phone: "2125550123", consent: "on", zip: "10001" })).toMatchObject({ source: "web_form", sourceRef: "f1", consent: true, postalCode: "10001" });
  });
  it("Meta webhook: signature check and lead ids", () => {
    const body = Buffer.from(JSON.stringify({ entry: [{ id: "page1", changes: [{ field: "leadgen", value: { leadgen_id: "L1", page_id: "page1", form_id: "F" } }] }] }));
    const sig = "sha256=" + createHmac("sha256", "appsecret").update(body).digest("hex");
    expect(verifyMetaSignature(body, sig, "appsecret")).toBe(true);
    expect(verifyMetaSignature(body, sig, "other")).toBe(false);
    expect(verifyMetaSignature(body, undefined, "appsecret")).toBe(false);
    expect(metaLeadIds(JSON.parse(body.toString()))).toEqual([{ leadgenId: "L1", pageId: "page1", formId: "F" }]);
  });
  it("Google LSA rows", () => {
    expect(fromLsaRow({ localServicesLead: { id: "777", leadType: "PHONE_CALL", serviceId: "hvac:ac_repair", contactDetails: { phoneNumber: "+12125550142", consumerName: "Jo" }, creationDateTime: "2026-11-20 10:00:00" } }))
      .toMatchObject({ source: "google_lsa", sourceRef: "777", phone: "+12125550142", name: "Jo", service: "ac repair" });
  });
  it("the email fallback reads platform notification emails", () => {
    const lead = parseLeadEmail({ from: "leads@angi.com", subject: "New lead: AC Repair", messageId: "m1", text: "Name: Maria Santos\nPhone: (212) 555-0142\nZip Code: 10001\nService Requested: AC Repair\nComments: blowing warm air" })!;
    expect(lead).toMatchObject({ source: "angi", sourceRef: "email:m1", name: "Maria Santos", phone: "(212) 555-0142", postalCode: "10001", service: "AC Repair", message: "blowing warm air" });
    expect(parseLeadEmail({ from: "x@y.com", subject: "hello", messageId: "m2", text: "no number here" })).toBeNull();
  });
});
