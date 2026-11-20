# Architecture

```
            ┌─────────────── Rasen (voice) ───────────────┐
 caller ──▶ │ number → agent (live version) → speech, LLM │──── call events (signed webhook) ───┐
            │        │ tools (HTTPS + per-org secret)      │                                      │
            └────────┼─────────────────────────────────────┘                                      │
                     ▼                                                                            ▼
   ┌──────────── Pine AI API (stateless, N instances) ────────────┐        ┌──── Pine AI workers (N) ────┐
   │ /api/tools/:org/:tool  → Integration Hub → connector ─▶ CRM   │        │ lead.call  (speed to lead)  │
   │ /api/webhooks/voice    → ingestCall (one writer)              │        │ lead.retry, call.finalise   │
   │ /api/intake/*          → acceptLead → enqueue lead.call       │◀─jobs─▶│ voice.sync (safety poll)    │
   │ /api/*                 → web app                              │        │ lsa.poll, campaign.sync     │
   └───────────────────────────────┬───────────────────────────────┘        └──────────────┬──────────────┘
                                   └──────────────── PostgreSQL ─────────────────────────────┘
```

## Rules that keep it correct

1. **Only `server/voice/rasen` talks to Rasen.**
2. **Ownership comes from our data.** A call belongs to the org that owns its agent; a tool call to
   the org whose secret it carries *and* whose agent id it names; a webhook to the org of its
   workspace. Never to an id in a request body.
3. **One writer of calls** (`ingestCall`): webhook and poller both use it. It is idempotent and
   order-safe (an older snapshot never overwrites a newer one).
4. **Billing is a compare-and-set** on `calls.charge_cents IS NULL` — a call is charged once no
   matter how many deliveries arrive. Whole minutes, rounded up; unanswered calls are free.
5. **Time math is ours, not the model's.** Agents pass what the customer said or the `start` of an
   offered window; `hub/slots.ts` and `lib/spoken.ts` do the rest in the client's time zone. A day
   without a time is refused, never booked at a default hour.
6. **Every automated dial goes through `placeCall`**: DNC, consent, the client's calling window
   (8:00–21:00 enforced), then the provider's call-start limit. "Not now" defers the job without
   spending an attempt; "never" ends it.
7. **Secrets** (voice keys, webhook secrets, CRM credentials) are AES-256-GCM encrypted at rest and
   never returned by the API. The agent tool secret is stored hashed for comparison.
8. **Per-customer memory**: every call carries `customer_name`, `profile` and `context`
   (bounded to ~3.5 KB), and every agent prompt renders them, with the rule "use the name on file,
   never ask for it". Inbound calls get the same through the before-call `lookup_customer` tool.

## Scaling

What scales horizontally here, and what does not:

- **API and workers are stateless.** Run as many as needed behind a load balancer. Jobs are
  claimed with `FOR UPDATE SKIP LOCKED`; a worker that dies loses its lock after 5 minutes and the
  job runs again (handlers are idempotent). The rate limiter is shared through PostgreSQL, so N
  processes together never exceed a provider limit.
- **PostgreSQL** is the system of record and the queue. Hot tables (`calls`, `leads`, `jobs`) are
  indexed by `(org_id, time)`. At very large volume: monthly range-partition `calls`/`leads`, move
  read-heavy dashboards to a replica, and move the queue to a dedicated database (or Redis/SQS)
  — the queue API (`enqueue`/`claim`) is the only thing that would change.
- **The real ceiling is the voice provider, not this code.** Rasen allows 10 call *starts* per
  minute per key and 60 per workspace. With one workspace per client (the plan's model, enforced
  here: one workspace cannot serve two clients), each client can start ~10 calls/minute; platform
  throughput grows with the number of clients. "10 crore calls at a time" is not something any
  single provider account supports today — reaching large concurrent volumes needs partner limits
  from Rasen, which ClusterX has said it will request. Bursts above the limit wait in the queue
  instead of failing.

## Data model (main tables)

`orgs` (settings = business rules) · `users`, `memberships` · `voice_workspaces` (encrypted key,
webhook secret, tool secret) · `agents` (config = source of truth) · `phone_numbers` · `customers`
(with consent and a CRM snapshot) · `leads` (unique per source + source id) · `calls` (transcript,
extraction, outcome, QA, billing) · `bookings` · `campaigns`, `campaign_recipients` · `dnc_list` ·
`integrations` (encrypted credentials, hashed inbound key) · `jobs`, `rate_events`,
`webhook_deliveries`, `inbound_lookups`, `audit_log`.

## Known gaps

- Connectors other than the built-in calendar and custom REST are not yet live-tested (partner
  access pending) — see README.
- Recording/transcript translation needs `OPENAI_API_KEY`.
- No hosted test-call URL is generated: the provider issues a token; staff paste it on Rasen's test
  page.
- Live call monitoring (Rasen's live transcript stream) is not wired into the UI yet.
- Reserve with Google (Actions Center) is a later phase in the plan and is not built.
