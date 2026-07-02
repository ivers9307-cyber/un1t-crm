-- CTWA attribution: persist Meta's click-to-WhatsApp click id from the first
-- inbound referral message so booking conversions can be fired to the
-- Conversions API (dataset configured per location in settings.meta_ads).
alter table contacts add column if not exists ctwa_clid text;
alter table contacts add column if not exists ctwa_clid_at timestamptz;

comment on column contacts.ctwa_clid is
  'Meta click-to-WhatsApp click id (referral.ctwa_clid) from the first inbound CTWA message; used for Conversions API booking events (mig 339)';
comment on column contacts.ctwa_clid_at is
  'When ctwa_clid was captured (mig 339)';
