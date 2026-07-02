-- CTWA attribution (part 2): referral.ctwa_clid only arrives on the FIRST
-- inbound message, and a click-to-WhatsApp lead often has no contact row yet.
-- Persist it on the conversation (always exists) so it can backfill onto the
-- contact when the conversation links.
alter table whatsapp_conversations add column if not exists ctwa_clid text;

comment on column whatsapp_conversations.ctwa_clid is
  'Meta click-to-WhatsApp click id from the first inbound referral message; backfills contacts.ctwa_clid on link (mig 340)';
