-- PERM-AUDIT.3 — one-time squash of profile_locations.permissions to
-- SPARSE diffs vs the role code defaults.
--
-- Context: both permission editors used to save FULL materialised
-- blobs (every key explicit), which froze the saving-time role
-- defaults into every user and made role changes / role-template
-- edits / new-feature defaults silently not apply. The editors +
-- save routes now store sparse diffs (PERM-AUDIT.3 code change) and
-- the push gate resolves through the shared resolver — this
-- migration retro-fits the existing rows to the same shape.
--
-- Semantics per row (mirrors shared/permissions.js
-- diffPermissionsBlob against the role's code defaults):
--   • keep a boolean key only when it DIFFERS from the role default;
--   • drop keys unknown to the defaults maps (stale/junk, e.g. the
--     pre-split `dashboard` key) — the resolver treats them as
--     absent anyway and the save-path sanitiser would drop them on
--     next save;
--   • keep the non-boolean mobile extras (layout,
--     lead_time_overrides) verbatim.
--
-- Effective permissions are IDENTICAL before and after: the resolver
-- reads explicit key → (template) → role default, and every dropped
-- key equalled its role default by construction. Role templates
-- (mig 364) are all empty at squash time, so code defaults ARE the
-- role base.
--
-- ⚠ APPLY ONLY AFTER the PERM-AUDIT.3 code deploy: the old push
-- gate read raw explicit-false keys, so sparse blobs under old code
-- would have re-enabled role-default-off notification categories.

WITH df AS (SELECT '{"web":{"master":{"dashboard_personal":true,"dashboard_studio":true,"dashboard_business":true,"dashboard_ads":true,"pipeline":true,"contacts":true,"activities":true,"churn_radar":true,"lead_radar":true,"engagement_analytics":true,"pulse_admin":true,"events":true,"bookings":true,"races":true,"email":true,"whatsapp":true,"sms":true,"schedule":true,"attendance_reports":true,"assistant":true,"studio_management":true,"contracts":true,"tv_displays":true,"glofox_import":true,"preferences_import":true,"presentations":true,"orders":true,"car_processing":true,"card_receipts":true,"invoices_inbox":true,"approvals_inbox":true,"automations":true,"challenges":true,"issues_inbox":true,"bookkeeper":true,"contact_linking":true,"consultations":true,"settings":true,"landing_page":true},"staff":{"dashboard_personal":true,"dashboard_studio":false,"dashboard_business":false,"dashboard_ads":false,"pipeline":true,"contacts":true,"activities":true,"churn_radar":false,"lead_radar":false,"engagement_analytics":false,"pulse_admin":false,"events":true,"bookings":true,"races":true,"email":false,"whatsapp":false,"sms":false,"schedule":true,"attendance_reports":false,"assistant":false,"studio_management":false,"contracts":false,"tv_displays":false,"glofox_import":false,"preferences_import":false,"presentations":false,"orders":false,"car_processing":false,"card_receipts":false,"invoices_inbox":false,"approvals_inbox":false,"automations":false,"challenges":false,"issues_inbox":false,"bookkeeper":false,"contact_linking":false,"consultations":false,"settings":false,"landing_page":false},"head_coach":{"dashboard_personal":true,"dashboard_studio":true,"dashboard_business":false,"dashboard_ads":false,"pipeline":true,"contacts":true,"activities":true,"churn_radar":true,"lead_radar":true,"engagement_analytics":true,"pulse_admin":true,"events":true,"bookings":true,"races":true,"email":true,"whatsapp":true,"sms":true,"schedule":true,"attendance_reports":false,"assistant":true,"studio_management":false,"contracts":false,"tv_displays":false,"glofox_import":false,"preferences_import":false,"presentations":true,"orders":false,"car_processing":false,"card_receipts":false,"invoices_inbox":false,"approvals_inbox":false,"automations":false,"challenges":false,"issues_inbox":false,"bookkeeper":false,"contact_linking":true,"consultations":true,"settings":false,"landing_page":false},"manager":{"dashboard_personal":true,"dashboard_studio":true,"dashboard_business":false,"dashboard_ads":true,"pipeline":true,"contacts":true,"activities":true,"churn_radar":false,"lead_radar":false,"engagement_analytics":true,"pulse_admin":true,"events":true,"bookings":true,"races":true,"email":true,"whatsapp":true,"sms":true,"schedule":true,"attendance_reports":true,"assistant":true,"studio_management":true,"contracts":false,"tv_displays":true,"glofox_import":false,"preferences_import":false,"presentations":true,"orders":true,"car_processing":false,"card_receipts":true,"invoices_inbox":false,"approvals_inbox":true,"automations":true,"challenges":true,"issues_inbox":false,"bookkeeper":false,"contact_linking":true,"consultations":true,"settings":true,"landing_page":false},"owner":{"dashboard_personal":true,"dashboard_studio":true,"dashboard_business":true,"dashboard_ads":true,"pipeline":true,"contacts":true,"activities":true,"churn_radar":true,"lead_radar":true,"engagement_analytics":true,"pulse_admin":true,"events":true,"bookings":true,"races":true,"email":true,"whatsapp":true,"sms":true,"schedule":true,"attendance_reports":true,"assistant":true,"studio_management":true,"contracts":true,"tv_displays":true,"glofox_import":false,"preferences_import":false,"presentations":true,"orders":true,"car_processing":false,"card_receipts":true,"invoices_inbox":true,"approvals_inbox":true,"automations":true,"challenges":true,"issues_inbox":true,"bookkeeper":false,"contact_linking":true,"consultations":true,"settings":true,"landing_page":true}},"mobile":{"master":{"schedule":true,"pipeline":true,"whatsapp":true,"assistant":true,"sms":true,"email":true,"tv_displays":true,"contacts":true,"tasks":true,"bookings":true,"time_off":true,"approvals":true,"staff_management":true,"issue_triage":true,"invoices_inbox":true,"card_receipts":true,"orders":true,"car_processing":true,"races":true,"invoices":true,"expenses":true,"issues":true,"contracts":true,"policies":true,"churn_radar":true,"lead_radar":true,"push_notifications":true,"notify_time_off":true,"notify_schedule":true,"notify_swap":true,"notify_lead":true,"notify_whatsapp":true,"notify_instagram":true,"notify_invoice_approved":true,"notify_invoice_declined":true,"notify_expense_submitted":true,"notify_expense_approved":true,"notify_expense_declined":true,"notify_shift_adjusted":true,"notify_contract_issued":true,"notify_tasks":true,"notify_bookings":true,"notify_checklist_overdue":true,"notify_checklist_compliance":true,"notify_issue_submitted":true,"notify_issue_resolved":true},"staff":{"schedule":true,"pipeline":false,"whatsapp":false,"assistant":false,"sms":false,"email":false,"tv_displays":false,"contacts":true,"tasks":true,"bookings":false,"time_off":true,"approvals":false,"staff_management":false,"issue_triage":false,"invoices_inbox":false,"card_receipts":false,"orders":false,"car_processing":false,"races":false,"invoices":true,"expenses":true,"issues":true,"contracts":true,"policies":true,"churn_radar":false,"lead_radar":false,"push_notifications":true,"notify_time_off":true,"notify_schedule":true,"notify_swap":true,"notify_lead":false,"notify_whatsapp":false,"notify_instagram":false,"notify_invoice_approved":true,"notify_invoice_declined":true,"notify_expense_submitted":false,"notify_expense_approved":true,"notify_expense_declined":true,"notify_shift_adjusted":true,"notify_contract_issued":true,"notify_tasks":true,"notify_bookings":false,"notify_checklist_overdue":true,"notify_checklist_compliance":false,"notify_issue_submitted":false,"notify_issue_resolved":true},"head_coach":{"schedule":true,"pipeline":true,"whatsapp":true,"assistant":true,"sms":true,"email":true,"tv_displays":false,"contacts":true,"tasks":true,"bookings":true,"time_off":true,"approvals":true,"staff_management":false,"issue_triage":false,"invoices_inbox":false,"card_receipts":false,"orders":false,"car_processing":false,"races":true,"invoices":true,"expenses":true,"issues":true,"contracts":true,"policies":true,"churn_radar":true,"lead_radar":true,"push_notifications":true,"notify_time_off":true,"notify_schedule":true,"notify_swap":true,"notify_lead":true,"notify_whatsapp":true,"notify_instagram":true,"notify_invoice_approved":true,"notify_invoice_declined":true,"notify_expense_submitted":true,"notify_expense_approved":true,"notify_expense_declined":true,"notify_shift_adjusted":true,"notify_contract_issued":true,"notify_tasks":true,"notify_bookings":true,"notify_checklist_overdue":true,"notify_checklist_compliance":true,"notify_issue_submitted":false,"notify_issue_resolved":true},"manager":{"schedule":true,"pipeline":true,"whatsapp":true,"assistant":true,"sms":true,"email":true,"tv_displays":true,"contacts":true,"tasks":true,"bookings":true,"time_off":true,"approvals":true,"staff_management":true,"issue_triage":false,"invoices_inbox":false,"card_receipts":true,"orders":true,"car_processing":false,"races":true,"invoices":true,"expenses":true,"issues":true,"contracts":true,"policies":true,"churn_radar":false,"lead_radar":false,"push_notifications":true,"notify_time_off":true,"notify_schedule":true,"notify_swap":true,"notify_lead":true,"notify_whatsapp":true,"notify_instagram":true,"notify_invoice_approved":true,"notify_invoice_declined":true,"notify_expense_submitted":true,"notify_expense_approved":true,"notify_expense_declined":true,"notify_shift_adjusted":true,"notify_contract_issued":true,"notify_tasks":true,"notify_bookings":true,"notify_checklist_overdue":true,"notify_checklist_compliance":true,"notify_issue_submitted":false,"notify_issue_resolved":true},"owner":{"schedule":true,"pipeline":true,"whatsapp":true,"assistant":true,"sms":true,"email":true,"tv_displays":true,"contacts":true,"tasks":true,"bookings":true,"time_off":true,"approvals":true,"staff_management":true,"issue_triage":true,"invoices_inbox":true,"card_receipts":true,"orders":true,"car_processing":false,"races":true,"invoices":true,"expenses":true,"issues":true,"contracts":true,"policies":true,"churn_radar":true,"lead_radar":true,"push_notifications":true,"notify_time_off":true,"notify_schedule":true,"notify_swap":true,"notify_lead":true,"notify_whatsapp":true,"notify_instagram":true,"notify_invoice_approved":true,"notify_invoice_declined":true,"notify_expense_submitted":true,"notify_expense_approved":true,"notify_expense_declined":true,"notify_shift_adjusted":true,"notify_contract_issued":true,"notify_tasks":true,"notify_bookings":true,"notify_checklist_overdue":true,"notify_checklist_compliance":true,"notify_issue_submitted":true,"notify_issue_resolved":true}}}'::jsonb AS d),
sparse AS (
  SELECT pl.id,
    (
      COALESCE((
        SELECT jsonb_object_agg(e.k, e.v)
        FROM jsonb_each(pl.permissions - 'mobile') AS e(k, v)
        WHERE jsonb_typeof(e.v) = 'boolean'
          AND df.d->'web'->pl.role ? e.k
          AND (df.d->'web'->pl.role->e.k) IS DISTINCT FROM e.v
      ), '{}'::jsonb)
      ||
      CASE WHEN mob.mobile_sparse = '{}'::jsonb THEN '{}'::jsonb
           ELSE jsonb_build_object('mobile', mob.mobile_sparse) END
    ) AS new_permissions
  FROM profile_locations pl
  CROSS JOIN df
  CROSS JOIN LATERAL (
    SELECT COALESCE((
      SELECT jsonb_object_agg(e.k, e.v)
      FROM jsonb_each(COALESCE(pl.permissions->'mobile', '{}'::jsonb)) AS e(k, v)
      WHERE (jsonb_typeof(e.v) = 'boolean'
             AND df.d->'mobile'->pl.role ? e.k
             AND (df.d->'mobile'->pl.role->e.k) IS DISTINCT FROM e.v)
         OR e.k IN ('layout', 'lead_time_overrides')
    ), '{}'::jsonb) AS mobile_sparse
  ) mob
  WHERE pl.permissions IS NOT NULL
    AND pl.permissions <> '{}'::jsonb
)
UPDATE profile_locations pl
SET permissions = s.new_permissions
FROM sparse s
WHERE pl.id = s.id
  AND pl.permissions IS DISTINCT FROM s.new_permissions;
