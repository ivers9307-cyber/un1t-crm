// INTEG-C1 — SaaS plan STRUCTURE registry (per-location pricing).
//
// Code keeps only keys and structure; every NUMBER (tier prices,
// allowances, overage rates, add-on prices) lives in the DB
// (plans / plan_versions, mig 413) and is master-editable at
// /admin/plans. If you are about to hard-code a price or allowance
// anywhere, stop — add it to a plan version instead.
//
// Plain JS, no Next.js / React imports (the shared/ seam — mobile can
// consume this via Metro if it ever needs to render plan features).

// Billing meters — the quantities plan allowances are keyed by.
// Naming aligns with the mig 411 usage ledger (usage_events /
// usage_rollups_daily): wa_template_send and email_send are rollup
// meters 1:1; ai_message has NO rollup meter yet — the ledger meters
// AI in tokens (meter='anthropic_tokens'), billing is per message, so
// enforcement derives the count from allowance-eligible usage_events
// rows (source != 'assistant_chat', which is metered but
// allowance-exempt per Richard 2026-07-19).
export const METERS = Object.freeze({
  wa_template_send: {
    label: 'WhatsApp templates',
    unit: 'message',
    rollupMeter: 'wa_template_send',
  },
  email_send: {
    label: 'Emails',
    unit: 'message',
    rollupMeter: 'email_send',
  },
  ai_message: {
    label: 'AI messages',
    unit: 'message',
    // Derived: COUNT of usage_events rows, meter='anthropic_tokens',
    // allowance-eligible sources only. No direct rollup meter.
    rollupMeter: null,
  },
})

export const METER_KEYS = Object.freeze(Object.keys(METERS))

// Overage rate keys on plan_versions.unit_rates_cents. WhatsApp splits
// marketing vs utility per Meta conversation category; email is priced
// per 1,000 sends; AI per message. All values are EUR cents (EUR-only
// v1, Ireland).
export const UNIT_RATE_KEYS = Object.freeze({
  wa_marketing: { label: 'WhatsApp marketing', per: 'message' },
  wa_utility:   { label: 'WhatsApp utility',   per: 'message' },
  email_per_1k: { label: 'Email',              per: '1,000 emails' },
  ai_message:   { label: 'AI message',         per: 'message' },
})

// Boolean feature flags on plan_versions.features. Structure here,
// inclusion per tier/add-on in the DB.
export const FEATURE_KEYS = Object.freeze({
  ai_agent:            { label: 'AI agent (Mia)' },
  custom_email_domain: { label: 'Custom email domain' },
})

// Add-on plan slugs the platform knows how to provision. An addon-kind
// plan row must use one of these slugs so provisioning code can key
// off it; its price lives on the plan's versions.
export const ADDON_KEYS = Object.freeze(['custom_email_domain'])

export const PLAN_KINDS = Object.freeze(['tier', 'addon'])
