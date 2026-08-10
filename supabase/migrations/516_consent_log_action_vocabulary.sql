-- 516 — GAPS-P6: one vocabulary for consent_log.action, enforced.
--
-- THE DEFECT
-- `consent_log.action` carries two spellings of the same two facts:
--
--     opt_out    14,214 rows      opted_out    83 rows
--     opt_in         84 rows      opted_in      3 rows
--
-- The origin is this table's own definition. Mig 005 created it with
--     action TEXT NOT NULL,   -- opted_in, opted_out
-- while every form/preference writer used opt_in/opt_out. `contacts.wa_status`
-- separately (and correctly) takes the VALUE 'opted_out', and that word was
-- copied out of the column where it belongs into one where it does not. The
-- writers that picked it up: src/lib/whatsapp-consent.js (STOP/START keywords,
-- and Meta's in-app user-preferences control) and, historically, the Postmark
-- `SubscriptionChange` handler in src/app/api/webhooks/postmark/route.js that
-- CAMPAIGN.13 replaced with the queue + processor — that one accounts for the
-- 13 `one_click_unsubscribe` rows spelled `opted_out`, and no longer exists.
--
-- WHY IT MATTERS
-- consent_log is the GDPR evidence trail. Any query, report or export
-- filtering `action = 'opt_out'` silently misses 83 real withdrawals of
-- consent — everyone who texted STOP on WhatsApp, and everyone who used
-- Meta's in-app marketing-preferences control. Nothing errors. The report is
-- just quietly wrong, in the direction of "we kept marketing to someone who
-- told us to stop". Mig 488 had to work around it by hand
-- (`action in ('opt_out','opted_out')`), which is the shape of a trap that
-- gets forgotten exactly once.
--
-- THIS IS A CORRECTION OF A RECORDING ERROR, NOT A REWRITE OF HISTORY.
-- The underlying consent facts are unchanged: the same person, on the same
-- channel, at the same instant, from the same source, still withdrew (or gave)
-- consent. Only the WORD used to record that fact changes, from one spelling
-- of it to the other. No contact's actual consent state is touched by this
-- migration — `contact_preferences`, `contact_location_preferences`,
-- `contacts.email_status` and `contacts.wa_status` are all left exactly as
-- they are. Nobody is opted in or out by applying this.
--
-- ⚠️ contacts.wa_status IS OUT OF SCOPE. 'opted_out' is the correct value
-- there and this migration must never touch it.
--
-- ORDERING: apply AFTER the code in this PR deploys. The CHECK depends on the
-- code change (whatsapp-consent.js now writes opt_out/opt_in via
-- src/lib/consent-actions.js); applied against the old code, every WhatsApp
-- STOP would violate the constraint. The consent write there is inside a
-- try/catch that swallows — so it would fail SILENTLY, which is the same
-- class of harm this migration exists to remove.
--
-- After applying, run get_advisors for BOTH types (security + performance).

-- 1. Refuse to proceed if the live table holds an action value outside the
--    four we measured. The CHECK below allowlists two; an unknown fifth value
--    would be rejected by it, and finding that out via a failed constraint
--    (which tells you nothing about what the value was) is strictly worse
--    than finding out here, by name and by count.
do $$
declare unexpected text;
begin
  select string_agg(format('%s (%s rows)', action, n), ', ' order by action)
    into unexpected
    from (
      select action, count(*) as n
        from consent_log
       where action not in ('opt_in', 'opt_out', 'opted_in', 'opted_out')
       group by action
    ) s;

  if unexpected is not null then
    raise exception
      'mig 516 ABORTED: consent_log.action holds unexpected value(s): %. Report before constraining — do not widen the CHECK without deciding what each one means.',
      unexpected;
  end if;
end $$;

-- 2. Backfill the 86 legacy rows onto the canonical vocabulary.
--    Only `action` is written. created_at, contact_id, channel, source,
--    ip_address, user_agent, performed_by and location_id are all untouched,
--    so the evidence each row carries is identical afterwards.
update consent_log set action = 'opt_out' where action = 'opted_out';
update consent_log set action = 'opt_in'  where action = 'opted_in';

-- 3. Make the drift impossible to reintroduce silently. A future writer that
--    copies 'opted_out' out of contacts.wa_status now fails loudly at the
--    database instead of adding another invisible row to the audit trail.
alter table consent_log
  add constraint consent_log_action_vocabulary
  check (action in ('opt_in', 'opt_out'));

-- 4. Prove it landed, and prove nothing was lost. The row COUNT per direction
--    must be conserved: an opt-out that existed under either spelling before
--    must still be an opt-out after.
do $$
declare
  optouts  int;
  optins   int;
  legacy   int;
  total    int;
begin
  select count(*) into optouts from consent_log where action = 'opt_out';
  select count(*) into optins  from consent_log where action = 'opt_in';
  select count(*) into legacy  from consent_log where action in ('opted_in', 'opted_out');
  select count(*) into total   from consent_log;

  if legacy > 0 then
    raise exception 'mig 516 FAILED: % rows still carry a legacy action spelling', legacy;
  end if;
  if optouts + optins <> total then
    raise exception 'mig 516 FAILED: % opt_out + % opt_in <> % total rows', optouts, optins, total;
  end if;

  -- Eyeball against the pre-migration measurement: 14,214 + 83 = 14,297
  -- opt-outs and 84 + 3 = 87 opt-ins. Small drift from live traffic between
  -- the audit and the apply is expected; a large one is not.
  raise notice 'mig 516 — consent_log vocabulary unified: % opt_out, % opt_in (expected ~14297 / ~87). CHECK constraint added.',
    optouts, optins;
end $$;

comment on column consent_log.action is
  'CANONICAL VOCABULARY (GAPS-P6, mig 516; CHECK-enforced): opt_in | opt_out. The legacy spellings opted_in/opted_out were a recording error backfilled by mig 516 — do NOT reintroduce them. Note contacts.wa_status separately and legitimately takes the VALUE ''opted_out''; that is a different column with a different vocabulary. Writers import CONSENT_ACTIONS from src/lib/consent-actions.js.';
