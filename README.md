# Pine AI — voice agents for home-service businesses

Custom AI phone agents that answer every call, call every new lead within a minute, run outbound
campaigns, and book jobs straight into the client's own software. Calls run on
[Rasen](https://rasen.ai); everything else — agent design, the Integration Hub, lead intake,
campaigns, QA and billing — is this codebase.

Built from *ClusterX Voice AI Platform: Implementation Plan* (Nov 2026).

## Run it locally

Needs Node 20+. No Docker and no PostgreSQL install: in development an embedded PostgreSQL starts
by itself (data in `./.pgdata`).

```bash
npm install
cp .env.example .env          # then fill ENCRYPTION_KEY and SESSION_SECRET (see the file)
npm run seed                  # optional: a demo client with sample calls, leads and bookings
npm run build                 # the web app
npm start                     # http://localhost:4000
```

Sign in with `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` from `.env`.
For live reload: `npm run dev` (API on :4000) and `npm run dev:web` (web on :5173, proxies `/api`).

To place real calls, a client needs a Rasen workspace key (Platform admin → client → Voice key) and
`PUBLIC_BASE_URL` must be a public https address so Rasen can reach the webhook and the tools.

## Checks

```bash
npm run check     # TypeScript, server + web
npm test          # 75 tests on a real (embedded) PostgreSQL; the voice provider is faked
npm run build
```

## What is in it

| Area | Where | Notes |
|---|---|---|
| Tenancy, auth | `server/auth`, `server/modules/orgs.ts` | Orgs, roles (owner/manager/viewer), platform staff, cookie sessions with CSRF header, session revocation |
| Voice layer | `server/voice/rasen` | The only code that talks to Rasen: agents (draft → publish), tools, numbers, calls, campaigns, usage, webhooks. Shared with the Pine AI CRM |
| Agent builder | `server/modules/agents.ts`, `server/voice/playbooks.ts` | 7 playbooks; prompt = playbook + client brief + business facts; tools attached at publish |
| Integration Hub | `server/hub` | 10 standard tools, one connector per system, time math done here, never by the model |
| Connectors | `server/hub/connectors` | Built-in calendar, ServiceTitan, Housecall Pro, Jobber, Salesforce, AccuLynx, custom REST, Google Calendar, Outlook |
| Messaging | `server/hub/notify.ts` | Twilio SMS (STOP honoured), Slack, email alerts |
| Lead intake | `server/intake` | Google LSA (polled), Meta, Yelp, Angi, Thumbtack, web forms, lead-email fallback; rules; < 60 s call |
| Calls | `server/modules/calls.ts` | One writer for webhook + poller; order-safe; billed once; opt-out → DNC |
| Campaigns | `server/modules/campaigns.ts` | Estimate follow-up, memberships, reactivation, after-job, reminders, CSV; consent + DNC applied |
| QA | `server/modules/qa.ts` | 0–100 score per call, coaching notes, "second chance" flags |
| Per-customer memory | `server/modules/customers.ts` | Name on file, profile, history, upcoming jobs → every call |
| Jobs | `server/queue`, `server/jobs.ts` | Durable PostgreSQL queue (SKIP LOCKED), retries, dead-letter, cross-process rate limiter |
| Web app | `web/` | React + Tailwind; dashboard, agents, calls (recording, transcript, translate), leads, customers, bookings, campaigns, numbers, integrations, settings, platform admin |

## Connector status — read before going live

Only the built-in calendar and the custom REST connector have been exercised end to end. Every
other connector is written against the vendor's published API and covered by tests that replay its
documented request/response shapes, **but has not yet run against a live account** — partner
access (ServiceTitan app approval, Jobber/Salesforce app, AccuLynx integrator access, Meta App
Review, Yelp Leads, Thumbtack partnership, Google Ads developer token) is still to be obtained.
The UI marks them "not live-tested yet". Expect small field-level fixes on first contact.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together and how it scales.
