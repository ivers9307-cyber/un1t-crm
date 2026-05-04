-- ============================================================
-- 091: branch step type — Tier 3E
--
-- Adds a new logical step_type 'branch' that doesn't send anything
-- but routes the enrolment down one of two paths based on a
-- predicate over the contact. Pure code-side change — no schema
-- gates need adjusting because:
--
--   * sequence_steps.step_type is a free TEXT column (no CHECK
--     constraint), so 'branch' is already valid.
--   * The branch's predicate + targets all live in the existing
--     sequence_steps.config JSONB column (added in mig 087).
--
-- Comment-only migration — documents the config schema for the
-- new step_type so future readers don't have to dig in
-- src/lib/sequences.js#processBranchStep to know what shape it
-- expects.
--
-- Branch config schema:
-- {
--   predicate: {
--     type: 'has_tag' | 'field_equals' | 'field_in',
--     -- has_tag args:
--     tag: 'race_completed',
--     -- field_equals args:
--     field: 'lead_status', value: 'member',
--     -- field_in args:
--     field: 'lead_status', values: ['member', 'lapsed_member']
--   },
--   then_step_order: 4,    -- where to jump if predicate is TRUE
--                          --   defaults to step_order + 1 (no skip)
--   else_step_order: 5     -- where to jump if predicate is FALSE
--                          --   defaults to step_order + 2 (skip 1 step)
-- }
--
-- Whitelisted fields (mirrors update_field's allow-list to avoid
-- predicate-based PII exfiltration via cleverly-crafted JSON):
--   lead_status, label, email_status, sms_status, marketing_opt_in
-- Anything else is rejected at evaluation time.
--
-- The runner refuses to chase pointers that loop backwards
-- (then_step_order <= current step_order) so an operator can't
-- accidentally build an infinite loop. To support genuine loop
-- patterns later we'd need a per-enrolment loop counter; deferred.
-- ============================================================

BEGIN;

COMMENT ON COLUMN sequence_steps.config IS
  'Free-form config for non-message step types. Schema by step_type: apply_tag → { tag }; update_field → { field, value }; internal_task → { subject, note, assignee_role, assignee_user_id, due_offset_minutes }; branch (mig 091) → { predicate: { type, ... }, then_step_order, else_step_order }. Existing message step types (email/whatsapp/sms) ignore this column.';

COMMIT;
