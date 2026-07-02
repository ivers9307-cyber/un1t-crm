-- WA-BLOCK — inbox "block sender": mirror of the Meta Block API state so the
-- unified inbox can render + toggle it (blocked senders cannot message the
-- number and it cannot message them).
alter table whatsapp_conversations add column if not exists is_blocked boolean not null default false;

comment on column whatsapp_conversations.is_blocked is
  'Sender blocked at Meta via the Block API (inbox action); blocked senders cannot message the number and it cannot message them (mig 342)';
