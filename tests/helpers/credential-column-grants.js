// SECFIX.3c (mig 648) — what `authenticated` may do, column by column, on the
// five tables that hold stored integration credentials. The single source for
// tests/migration-648-credential-column-grants.test.js and
// tests/credential-column-grants-guard.test.js. A column added to `locations`
// or `contact_external_integrations` goes into exactly one of select /
// withheld, in the same PR as the migration that adds it.

export const CREDENTIAL_GRANT_MIGRATION = 648

export const CREDENTIAL_COLUMN_GRANTS = Object.freeze({
  // select = the location's public identity (what /api/mobile/me and the user
  // object already serve every staff member) + organization_id, which the
  // organisations/contracts/storage policies join on.
  // update = exactly what LocationForm (edit) and CarDepositSettings write.
  locations: Object.freeze({
    select: Object.freeze(['id', 'name', 'slug', 'address', 'phone', 'email', 'timezone', 'active',
      'created_at', 'updated_at', 'country', 'features', 'organization_id', 'is_host_anchor',
      // W1.M1 (mig 717): the membership source is public identity, not a
      // credential; the phone's Studio tab and the browser gate on it.
      'membership_source']),
    update: Object.freeze(['name', 'slug', 'address', 'phone', 'email', 'timezone', 'country', 'active',
      'monthly_contractor_budget_eur', 'invoices_inbound_slug', 'updated_at', 'car_deposit_default_amount',
      'car_deposit_terms', 'car_deposit_terms_version', 'car_deposit_receipt_sms_enabled']),
    withheld: Object.freeze(['settings', 'sensibo_api_key', 'thinq_pat', 'thinq_client_id', 'thinq_country_code',
      'sensibo_pod_id', 'ac_default_mode', 'ac_default_temp', 'ac_default_fan', 'ac_session_minutes',
      'twilio_alpha_sender_id', 'bca_config', 'notification_config', 'churn_digest_recipients',
      'monthly_contractor_budget_eur', 'invoices_inbound_slug', 'email_inbox_reply_to', 'dunning_sequence_id',
      'dunning_auto_enroll', 'glofox_auto_cancel_memberships', 'car_deposit_default_amount', 'car_deposit_terms',
      'car_deposit_terms_version', 'car_deposit_whatsapp_template_id', 'car_deposit_receipt_sms_enabled']),
  }),
  // select = what the member integrations screens (mobile + champ-app) name.
  // update = the auto-export toggle and disconnect.
  contact_external_integrations: Object.freeze({
    select: Object.freeze(['id', 'contact_id', 'provider', 'external_athlete_id', 'auto_export_enabled',
      'connected_at', 'disconnected_at', 'last_export_at', 'last_error']),
    update: Object.freeze(['auto_export_enabled', 'disconnected_at']),
    withheld: Object.freeze(['access_token', 'refresh_token', 'expires_at', 'scopes', 'import_backfilled_at']),
  }),
})

/** No client role holds any privilege on these (no browser or phone reader or writer exists). */
export const NO_CLIENT_ACCESS_TABLES = Object.freeze(['channel_connections', 'whatsapp_numbers', 'xero_connections'])

export const CREDENTIAL_GRANT_TABLES = Object.freeze([...Object.keys(CREDENTIAL_COLUMN_GRANTS), ...NO_CLIENT_ACCESS_TABLES])

/** The only client files allowed to WRITE these tables, and only with .update(). */
export const CLIENT_WRITERS = Object.freeze({
  locations: Object.freeze(['src/components/LocationForm.jsx', 'src/components/CarDepositSettings.jsx']),
  contact_external_integrations: Object.freeze(['mobile/app/(member)/account/integrations.jsx']),
})
