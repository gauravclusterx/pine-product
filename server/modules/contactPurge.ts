/**
 * Delete a contact the way the CRM purges one: their bookings, text messages, leads and call
 * hints go; their calls stay in the call log but are unlinked and tombstoned (contact_purged), so
 * a campaign sync, a late webhook or the AI backfill never brings the contact back.
 */
import { tx } from "../db/pool.js";

export async function purgeContact(orgId: string, customerId: string): Promise<{ bookings: number; messages: number; leads: number; calls: number } | null> {
  return tx(async (t) => {
    const c = (await t("SELECT id, phone_e164 FROM customers WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, customerId]))[0];
    if (!c) return null;
    const calls = await t(
      "UPDATE calls SET contact_purged = true, customer_id = NULL, updated_at = now() WHERE org_id = $1 AND (customer_id = $2 OR phone_e164 = $3) RETURNING id",
      [orgId, c.id, c.phone_e164]
    );
    const bookings = await t(
      "DELETE FROM bookings WHERE org_id = $1 AND (customer_id = $2 OR call_id = ANY($3::uuid[])) RETURNING id",
      [orgId, c.id, calls.map((x) => x.id)]
    );
    const messages = await t("DELETE FROM messages WHERE org_id = $1 AND (customer_id = $2 OR phone_e164 = $3) RETURNING id", [orgId, c.id, c.phone_e164]);
    const leads = await t("DELETE FROM leads WHERE org_id = $1 AND (customer_id = $2 OR phone_e164 = $3) RETURNING id", [orgId, c.id, c.phone_e164]);
    await t("DELETE FROM call_hints WHERE org_id = $1 AND phone_e164 = $2", [orgId, c.phone_e164]);
    await t("DELETE FROM customers WHERE id = $1", [c.id]);
    return { bookings: bookings.length, messages: messages.length, leads: leads.length, calls: calls.length };
  });
}
