/** Dashboard numbers and usage billing. All aggregates are per org and per time range. */
import { q } from "../db/pool.js";

export async function dashboard(orgId: string, from: Date, to: Date) {
  const [calls] = await q(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
            count(*) FILTER (WHERE direction = 'outbound')::int AS outbound,
            count(*) FILTER (WHERE outcome = 'booked')::int AS booked,
            count(*) FILTER (WHERE outcome = 'no_contact')::int AS no_contact,
            count(*) FILTER (WHERE outcome = 'transferred')::int AS transferred,
            COALESCE(sum(billable_seconds), 0)::int AS seconds,
            COALESCE(sum(charge_cents), 0)::int AS charge_cents,
            round(avg(qa_score))::int AS avg_qa,
            count(*) FILTER (WHERE (qa->>'secondChance')::boolean)::int AS second_chance
     FROM calls WHERE org_id = $1 AND started_at >= $2 AND started_at < $3`,
    [orgId, from, to]
  );
  const [bookings] = await q(
    `SELECT count(*)::int AS total, COALESCE(sum(value_cents), 0)::int AS value_cents,
            count(*) FILTER (WHERE starts_at > now() AND status IN ('booked','rescheduled'))::int AS upcoming
     FROM bookings WHERE org_id = $1 AND created_at >= $2 AND created_at < $3 AND status <> 'cancelled'`,
    [orgId, from, to]
  );
  const [leads] = await q(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'booked')::int AS booked,
            count(*) FILTER (WHERE status = 'lost')::int AS lost,
            count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_call_at - received_at))) FILTER (WHERE first_call_at IS NOT NULL) AS median_seconds_to_call,
            count(*) FILTER (WHERE first_call_at IS NOT NULL AND first_call_at - received_at <= interval '60 seconds')::int AS called_within_60s,
            count(*) FILTER (WHERE first_call_at IS NOT NULL)::int AS called
     FROM leads WHERE org_id = $1 AND received_at >= $2 AND received_at < $3`,
    [orgId, from, to]
  );
  const bySource = await q(
    `SELECT source, count(*)::int AS leads, count(*) FILTER (WHERE status = 'booked')::int AS booked
     FROM leads WHERE org_id = $1 AND received_at >= $2 AND received_at < $3 GROUP BY source ORDER BY leads DESC`,
    [orgId, from, to]
  );
  const daily = await q(
    `SELECT date_trunc('day', started_at AT TIME ZONE o.timezone)::date AS day, count(*)::int AS calls,
            count(*) FILTER (WHERE c.outcome = 'booked')::int AS booked
     FROM calls c JOIN orgs o ON o.id = c.org_id WHERE c.org_id = $1 AND c.started_at >= $2 AND c.started_at < $3 GROUP BY 1 ORDER BY 1`,
    [orgId, from, to]
  );
  const outcomes = await q(
    "SELECT COALESCE(outcome, 'in_progress') AS outcome, count(*)::int AS n FROM calls WHERE org_id = $1 AND started_at >= $2 AND started_at < $3 GROUP BY 1 ORDER BY n DESC",
    [orgId, from, to]
  );
  const agents = await q(
    `SELECT a.id, a.name, count(c.id)::int AS calls, count(c.id) FILTER (WHERE c.outcome = 'booked')::int AS booked, round(avg(c.qa_score))::int AS avg_qa
     FROM agents a LEFT JOIN calls c ON c.agent_id = a.id AND c.started_at >= $2 AND c.started_at < $3
     WHERE a.org_id = $1 AND a.status <> 'archived' GROUP BY a.id, a.name ORDER BY calls DESC`,
    [orgId, from, to]
  );
  const feed = await q(
    "SELECT action, detail, created_at FROM audit_log WHERE org_id = $1 AND action IN ('team.alert','call.second_chance','lead.received') ORDER BY created_at DESC LIMIT 20",
    [orgId]
  );
  // Booked revenue and Pine AI cost per day (in the org's time zone), for the revenue chart.
  const money = await q(
    `SELECT d::date AS day,
            COALESCE((SELECT sum(b.value_cents) FROM bookings b WHERE b.org_id = $1 AND b.status <> 'cancelled'
                      AND (b.created_at AT TIME ZONE o.timezone)::date = d::date), 0)::int AS revenue_cents,
            COALESCE((SELECT sum(c.charge_cents) FROM calls c WHERE c.org_id = $1
                      AND (c.started_at AT TIME ZONE o.timezone)::date = d::date), 0)::int AS cost_cents
     FROM orgs o, generate_series(($2::timestamptz AT TIME ZONE o.timezone)::date, ($3::timestamptz AT TIME ZONE o.timezone)::date, interval '1 day') d
     WHERE o.id = $1 ORDER BY 1`,
    [orgId, from, to]
  );
  const recentBookings = await q(
    `SELECT b.id, b.job_type, b.starts_at, b.created_at, b.value_cents, b.status, cu.name AS customer_name,
            c.direction, EXTRACT(EPOCH FROM (c.started_at - l.received_at))::int AS seconds_to_call
     FROM bookings b LEFT JOIN customers cu ON cu.id = b.customer_id LEFT JOIN calls c ON c.id = b.call_id LEFT JOIN leads l ON l.id = b.lead_id
     WHERE b.org_id = $1 AND b.status <> 'cancelled' ORDER BY b.created_at DESC LIMIT 4`,
    [orgId]
  );
  const [afterHours] = await q(
    `SELECT count(*)::int AS n FROM calls c JOIN orgs o ON o.id = c.org_id
     WHERE c.org_id = $1 AND c.started_at >= $2 AND c.started_at < $3
       AND (EXTRACT(HOUR FROM c.started_at AT TIME ZONE o.timezone) NOT BETWEEN 8 AND 17 OR EXTRACT(ISODOW FROM c.started_at AT TIME ZONE o.timezone) > 5)`,
    [orgId, from, to]
  );
  const connected = calls.total - calls.no_contact;
  return {
    range: { from, to },
    calls: { ...calls, minutes: Math.ceil(calls.seconds / 60), bookingRate: connected > 0 ? calls.booked / connected : 0, after_hours: afterHours.n },
    bookings,
    leads: { ...leads, median_seconds_to_call: leads.median_seconds_to_call == null ? null : Math.round(leads.median_seconds_to_call) },
    bySource, daily, outcomes, agents, feed, money, recentBookings,
  };
}

/** Platform staff overview: every client together, for the admin dashboard. */
export async function platformOverview(from: Date, to: Date) {
  const [orgs] = await q(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE created_at >= $1)::int AS new_in_range,
            (SELECT count(*)::int FROM voice_workspaces) AS voice_connected,
            (SELECT count(*)::int FROM agents WHERE status = 'live') AS live_agents,
            (SELECT count(*)::int FROM users WHERE NOT disabled) AS users
     FROM orgs`,
    [from]
  );
  const [calls] = await q(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE outcome = 'booked')::int AS booked,
            COALESCE(sum(billable_seconds), 0)::int AS seconds, COALESCE(sum(charge_cents), 0)::int AS charge_cents
     FROM calls WHERE started_at >= $1 AND started_at < $2`,
    [from, to]
  );
  const [bookings] = await q(
    "SELECT count(*)::int AS total, COALESCE(sum(value_cents), 0)::int AS value_cents FROM bookings WHERE created_at >= $1 AND created_at < $2 AND status <> 'cancelled'",
    [from, to]
  );
  const daily = await q(
    `SELECT d::date AS day,
            COALESCE((SELECT sum(charge_cents) FROM calls c WHERE c.started_at >= d AND c.started_at < d + interval '1 day'), 0)::int AS billed_cents,
            (SELECT count(*) FROM calls c WHERE c.started_at >= d AND c.started_at < d + interval '1 day')::int AS calls
     FROM generate_series(date_trunc('day', $1::timestamptz), date_trunc('day', $2::timestamptz), interval '1 day') d ORDER BY 1`,
    [from, to]
  );
  const topClients = await q(
    `SELECT o.id, o.name, o.industry, count(c.id)::int AS calls, COALESCE(sum(c.charge_cents), 0)::int AS charge_cents,
            count(c.id) FILTER (WHERE c.outcome = 'booked')::int AS booked
     FROM orgs o LEFT JOIN calls c ON c.org_id = o.id AND c.started_at >= $1 AND c.started_at < $2
     GROUP BY o.id ORDER BY charge_cents DESC, calls DESC LIMIT 5`,
    [from, to]
  );
  return { range: { from, to }, orgs, calls: { ...calls, minutes: Math.ceil(calls.seconds / 60) }, bookings, daily, topClients };
}

/** One org's billable usage for an invoice period: minutes and charges, per agent and per day. */
export async function usage(orgId: string, from: Date, to: Date) {
  const [total] = await q(
    "SELECT count(*)::int AS calls, COALESCE(sum(billable_seconds),0)::int AS seconds, COALESCE(sum(charge_cents),0)::int AS charge_cents FROM calls WHERE org_id = $1 AND status = 'ended' AND started_at >= $2 AND started_at < $3",
    [orgId, from, to]
  );
  const perAgent = await q(
    `SELECT a.name, count(*)::int AS calls, COALESCE(sum(c.billable_seconds),0)::int AS seconds, COALESCE(sum(c.charge_cents),0)::int AS charge_cents
     FROM calls c LEFT JOIN agents a ON a.id = c.agent_id WHERE c.org_id = $1 AND c.status = 'ended' AND c.started_at >= $2 AND c.started_at < $3 GROUP BY a.name ORDER BY charge_cents DESC`,
    [orgId, from, to]
  );
  return { ...total, minutes: Math.ceil(total.seconds / 60), perAgent };
}

/** Platform view: every client's usage for the period (for invoicing). */
export async function platformUsage(from: Date, to: Date) {
  return q(
    `SELECT o.id, o.name, o.rate_cents_per_minute, count(c.id)::int AS calls, COALESCE(sum(c.billable_seconds),0)::int AS seconds, COALESCE(sum(c.charge_cents),0)::int AS charge_cents
     FROM orgs o LEFT JOIN calls c ON c.org_id = o.id AND c.status = 'ended' AND c.started_at >= $1 AND c.started_at < $2
     GROUP BY o.id ORDER BY charge_cents DESC`,
    [from, to]
  );
}
