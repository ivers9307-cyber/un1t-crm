-- 331 — whatsapp_broadcast_recipients: unique (broadcast_id, contact_id)
--
-- COMMS-AUDIT batch 2. The WhatsApp blast send loop (lib/whatsapp.js
-- sendBroadcast) inserted the recipient row AFTER the Meta send and had
-- no status guard, so a second POST /send re-ran the whole audience and
-- re-blasted every contact. The SMS sibling is protected by a unique
-- (broadcast_id, contact_id) constraint that lets the send loop "claim"
-- a recipient row before sending (insert-then-send); the WhatsApp table
-- only had plain indexes, so the same claim-first pattern couldn't be a
-- real mutex here. Add the matching constraint.
--
-- Defensive dedup first: keep the earliest physical row per pair (there
-- are none in prod today — verified 0 duplicate pairs across 202 rows —
-- but a forward-only migration must not assume that).

delete from whatsapp_broadcast_recipients a
using whatsapp_broadcast_recipients b
where a.broadcast_id = b.broadcast_id
  and a.contact_id = b.contact_id
  and a.ctid > b.ctid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'whatsapp_broadcast_recipients_broadcast_contact_key'
  ) then
    alter table whatsapp_broadcast_recipients
      add constraint whatsapp_broadcast_recipients_broadcast_contact_key
      unique (broadcast_id, contact_id);
  end if;
end $$;

comment on constraint whatsapp_broadcast_recipients_broadcast_contact_key
  on whatsapp_broadcast_recipients is
  'COMMS-AUDIT batch 2 (mig 331) — one recipient row per (broadcast, contact). The send loop claims a row (insert status=pending) before the Meta send, so a duplicate /send or a crash-retry can never double-blast a contact.';
