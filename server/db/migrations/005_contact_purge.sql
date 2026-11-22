-- Deleting a contact purges what belongs to them (bookings, messages, leads, call hints). Their
-- calls stay in the call log, marked so that no later sync, campaign link or AI backfill ever
-- re-creates the contact from them (the CRM's purge tombstone).
ALTER TABLE calls ADD COLUMN contact_purged boolean NOT NULL DEFAULT false;
