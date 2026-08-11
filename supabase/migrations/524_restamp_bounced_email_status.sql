-- 524 — EMAILREP.2: re-suppress addresses a preference edit un-suppressed.
--
-- THE DEFECT (fixed in this migration's sibling commit)
-- /api/contacts/[id]/marketing-preferences PATCH ended with an unguarded
--     .from('contacts').update({ email_status: 'active' })
-- fired on ANY change to email_marketing, an opt-OUT included. contacts.
-- email_status is REPUTATION (mig 492/501: active | bounced | complained),
-- and it is a hard send-time gate: buildAudienceQuery applies
-- .not('email_status','in','("bounced","complained")') UNCONDITIONALLY — to
-- administrative mail as well as marketing. So a routine staff preference
-- edit put dead and complaining mailboxes back into the sendable audience.
--
-- This migration deals with the rows already on disk. Data-only, no DDL,
-- forward-only, idempotent (a re-run finds nothing: the rows it fixes no
-- longer read 'active').
--
-- WHY REPAIR AT ALL, when the August total_delivered history was deliberately
-- left wrong: that was unrecoverable history. This is CURRENT STATE that a
-- bug set and that is actively wrong — one of the three contacts below can
-- be marketed to right now, and all three are reachable by transactional
-- mail this minute.
--
-- DRIVEN BY EVIDENCE, NOT A LIST OF IDS
-- The predicate is "we hold a hard-bounce event for the address this contact
-- currently has, and nothing since says the address recovered". It re-derives
-- itself, so it is still correct if the data moves between writing and
-- applying, and it repairs any row a not-yet-found writer corrupts the same
-- way. Hard bounces only: a 'transient'/'soft' bounce never justified a
-- suppression and must not create one here, and 'rejected' (campaign-sender's
-- send-time refusal, mig 518) is our own refusal to send, not the receiving
-- server's verdict on the mailbox.
--
-- Both evidence tables are read. email_sends is the per-send ledger; a hard
-- bounce normally lands on BOTH it and campaign_recipients, but the
-- 2026-05-13 postmark_suppression_backfill wrote campaign_recipients only —
-- two of the three rows below are visible in that table alone, so reading
-- either one on its own misses them.
--
-- THE ADDRESS GUARD — do not undo a legitimate clear
-- Reputation is bound to a MAILBOX, not to a person (see
-- src/lib/email-reputation.js). EMAILREP.1 clears email_status when staff
-- correct a typo'd address, and that clear is CORRECT: the bounce describes
-- a mailbox the contact no longer has. So the bounce evidence only counts
-- when the address it was addressed to is still the address on the contact,
-- compared lower/trimmed because contacts are stored mixed-case. A contact
-- whose address was fixed after bouncing is left alone. campaign_recipients
-- has no to_email of its own, so it borrows one from the email_sends row
-- sharing its postmark_message_id (all 34 hard-bounce rows join; verified).
--
-- POST-BOUNCE ENGAGEMENT — the case where re-suppressing would be wrong
-- An open, a click or a delivery recorded AFTER the last hard bounce, to the
-- same address, is the receiving server telling us the mailbox works again
-- (a mailbox restored, a domain's MX fixed, a Postmark un-suppression that
-- also cleared our flag). Blindly re-stamping 'bounced' would re-kill an
-- address we have live proof of. Those rows are excluded rather than
-- re-suppressed. Live count today: ZERO of the three has any post-bounce
-- open, click or delivery — the exclusion is a correctness guard for the
-- re-run and for future rows, not something that changes today's outcome.
--
-- REPUTATION ONLY — consent is not touched
-- No write to email_marketing / contact_preferences / contact_location_
-- preferences, and no consent_log row: nobody's consent decision changed,
-- and re-stamping is not one. Nothing reaches consent by trigger either —
-- the only trigger on contacts that fires for an email_status update is
-- contacts_updated_at (checked against pg_trigger, not assumed; the
-- preference-fan-out triggers hang off contact_preferences, and the others
-- are INSERT-only or keyed on glofox_/phone columns). The one contact who is currently marketable
-- keeps their opt-in on record; the reputation gate is simply back in front
-- of it. (That contact's opt-in is a real 'admin_panel' consent_log entry
-- from 2026-07-09 — the same operator click that wiped the bounce. The
-- consent stands; only the un-suppression was a bug.)
--
-- ROWS THIS AFFECTS (verified against the live DB, 2026-08-11) — 3 of the 34
-- contacts holding a hard bounce; the other 31 already read 'bounced'.
--   e700bd7e-4cee-4eee-a56a-1ff1649743f5  donoshaughnessy@gmail.com
--       hard bounce 2026-05-13 19:38 UTC (campaign_recipients only)
--   632c016f-ed2a-431c-99c4-4271af139729  andrew@rocagencies.ie
--       hard bounce 2026-05-13 19:49 UTC (campaign_recipients only)
--   01c5a78a-49a2-4b5c-b15b-c35d15e97320  richard@richardivers.cpp
--       hard bounce 2026-06-08 19:15 UTC (both tables). '.cpp' is a typo of
--       '.com' — the mailbox does not exist. This is the one still carrying
--       email_marketing = true at its location, i.e. the one a campaign
--       would have mailed today.
-- All three still hold the exact address that bounced, and none has an open,
-- click or delivery after it. All three keep email_administrative = true, so
-- until this lands they are also reachable by booking confirmations and
-- reminders — which is the harm, not a side note: the transactional stream is
-- the one whose deliverability we can least afford to spend.

-- The CTEs are statement-level, not correlated per contact: `ev` scans the
-- two ledgers exactly once instead of once per row.
with ev as (
  -- Every email event we hold, tagged with the address it was sent to.
  select es.contact_id,
         lower(btrim(es.to_email)) as addr,
         es.bounce_type, es.bounced_at, es.opened_at, es.clicked_at, es.delivered_at
    from public.email_sends es
   where es.contact_id is not null
     and es.to_email is not null
  union all
  select cr.contact_id,
         lower(btrim(es.to_email)),
         cr.bounce_type, cr.bounced_at, cr.opened_at, cr.clicked_at, cr.delivered_at
    from public.campaign_recipients cr
    join public.email_sends es
      on es.postmark_message_id = cr.postmark_message_id
   where cr.contact_id is not null
     and es.to_email is not null
),
hard_bounce as (
  select contact_id, addr, max(bounced_at) as last_hard_bounce
    from ev
   where bounce_type = 'hard'
     and bounced_at is not null
   group by contact_id, addr
),
to_resuppress as (
  select distinct hb.contact_id
    from hard_bounce hb
    join public.contacts c
      on c.id = hb.contact_id
   where c.email_status = 'active'
     and c.email is not null
     -- the bounce describes the address the contact still has
     and hb.addr = lower(btrim(c.email))
     -- …and nothing since says that address recovered
     and not exists (
       select 1
         from ev e
        where e.contact_id = hb.contact_id
          and e.addr = hb.addr
          and greatest(coalesce(e.opened_at,    '-infinity'::timestamptz),
                       coalesce(e.clicked_at,   '-infinity'::timestamptz),
                       coalesce(e.delivered_at, '-infinity'::timestamptz))
              > hb.last_hard_bounce
     )
)
update public.contacts c
   set email_status = 'bounced'
  from to_resuppress t
 where c.id = t.contact_id
   and c.email_status = 'active';
