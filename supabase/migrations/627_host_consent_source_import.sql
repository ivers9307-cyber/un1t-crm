-- 627 — host consent can come from an operator import.
--
-- Richard, 25 Sep 2026: bulk-add Pride Training Club's "Gym Session Interest
-- List" (215 emails, 27 new to the list) to the host's list with host
-- marketing consent. None of the existing sources describe that honestly —
-- mailing_list_form / event_form are public-form opt-ins, backfill_2026_09 is
-- the one-off HOST-CONSENT.1 backfill — so the import gets its own label and
-- stays distinguishable in host_contacts and consent_log forever.
--
-- Additive: the old vocabulary is a strict subset, so every existing row
-- still passes.

alter table host_contacts
  drop constraint if exists host_contacts_marketing_consent_source_check;
alter table host_contacts
  add constraint host_contacts_marketing_consent_source_check
  check (marketing_consent_source is null or marketing_consent_source in
    ('mailing_list_form', 'event_form', 'backfill_2026_09', 'host_resubscribe', 'host_import'));
