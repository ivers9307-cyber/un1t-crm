// Contracts engine — template variable resolution + render.
//
// Mig 106 introduces `contract_templates` (markdown bodies with
// `{{variable}}` placeholders) and `contracts` (issued instances
// with frozen body + variables_data). This module owns the
// variable-derivation and substitution logic so it can be reused
// from the API route, the email/PDF pipeline, and the unit tests.
//
// Four sources of variables, merged in this priority (later
// wins):
//   1. Profile-derived auto-fills (full_name, email, role, ...)
//   2. Compensation-derived auto-fills (annual_salary, hourly_rate,
//      contracted_rate, contracted_hours_per_week)
//   3. CONTRACTS-VARS.2 — location-derived auto-fills (location_name,
//      location_address, location_phone, location_email,
//      company_name), resolved server-side only from the recipient's
//      location + getLocationBranding() — see locationVariables().
//   4. Custom variables provided by the issuer at issue time
//      (declared in the template's variables_schema JSONB, or
//      defaulted per-key via variables_schema[].default).
//
// Once the contract is issued the merged map is stored in
// `contracts.variables_data` and the rendered body is stored in
// `contracts.body_rendered`. Both are immutable from then on so
// the recipient signs exactly what they read.
//
// Audit-log adjacent: this module does NOT write to the DB. It
// only renders + validates. The API route is responsible for
// persisting the issued row and for state-machine transitions.

import { dublinTodayStr } from '@/lib/dublin-time'

/**
 * Build the auto-fill variable map from a profile row.
 *
 * Pure function — caller passes the relevant profile shape;
 * we never reach into Supabase here. Returns a flat string-keyed
 * map suitable for direct use in the substitution step.
 *
 * @param {object} profile — must include id, full_name, email,
 *                          role, employment_type, annual_salary,
 *                          hourly_rate, contracted_rate,
 *                          contracted_hours_per_week.
 * @returns {Record<string, string>}
 */
export function profileVariables(profile) {
  if (!profile) return {}
  const v = {}
  // Identity
  if (profile.full_name) v.full_name = String(profile.full_name)
  if (profile.email) v.email = String(profile.email)
  if (profile.role) v.role = String(profile.role)
  if (profile.employment_type) v.employment_type = String(profile.employment_type)

  // Compensation — formatted for display (currency / number).
  // We expose the raw numeric AND the formatted variant so a
  // template can use {{annual_salary}} (€60,000) or
  // {{annual_salary_raw}} (60000) depending on context.
  if (profile.annual_salary != null) {
    v.annual_salary_raw = String(profile.annual_salary)
    v.annual_salary = formatEuro(profile.annual_salary)
  }
  if (profile.hourly_rate != null) {
    v.hourly_rate_raw = String(profile.hourly_rate)
    v.hourly_rate = formatEuro(profile.hourly_rate)
  }
  // Overtime rate (numeric on profiles; for FTEs the legal premium
  // for hours beyond contracted_hours_per_week, for contractors the
  // higher rate after a per-day cap if applicable). Templates can
  // reference {{overtime_rate}} for either employment type.
  if (profile.overtime_rate != null) {
    v.overtime_rate_raw = String(profile.overtime_rate)
    v.overtime_rate = formatEuro(profile.overtime_rate)
  }
  if (profile.contracted_hours_per_week != null) {
    v.contracted_hours_per_week = String(profile.contracted_hours_per_week)
  }

  // Today, pre-computed for templates that want a default
  // {{today}} when the issuer doesn't override start_date.
  v.today = dublinTodayStr()

  return v
}

/**
 * Format a raw numeric value as a euro string. Plays nicely with
 * Intl.NumberFormat — uses Irish English locale to match the rest
 * of the CRM. NULL / NaN / undefined → empty string (rendered
 * placeholders look bad if the underlying value is missing — better
 * to surface that the variable wasn't provided).
 */
export function formatEuro(value) {
  // Treat null / undefined / empty-string as "missing" — Number()
  // would coerce them to 0/NaN respectively, but we want a clean
  // empty-string render when the source field isn't set.
  if (value == null || value === '') return ''
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: n % 1 === 0 ? 0 : 2,
  }).format(n)
}

/**
 * Merge variable sources in the documented priority. Later
 * arguments win — so customVariables (from the issuer) overrides
 * profile auto-fills.
 */
export function mergeVariables(profile, customVariables) {
  return {
    ...profileVariables(profile),
    ...(customVariables || {}),
  }
}

// =============================================================
// CONTRACTS-VARS.2 — location auto-fill variables
// =============================================================

// Keys locationVariables() may produce. Exported so callers (the
// issue wizard) can treat these as "resolved elsewhere" without
// hard-coding the list in two places — e.g. unresolvedPlaceholders()'s
// assumeKeys option.
export const LOCATION_VAR_KEYS = [
  'location_name',
  'location_address',
  'location_phone',
  'location_email',
  'company_name',
  // LEGALENT.1 — the contracting COMPANY (org_settings.legal_entity_name,
  // mig 425), distinct from company_name, which is the brand. A party
  // clause must name the entity; resolved server-side at issue time via
  // getContractingEntity() and always non-empty (it degrades to the
  // brand), so it can never leave an unresolved placeholder.
  'legal_entity_name',
]

/**
 * Build the location-derived auto-fill variable map. Pure — caller
 * passes the location row (from `public.locations`: name, address,
 * phone, email) and the resolved branding object (from
 * getLocationBranding(), which already inherits location ->
 * organisation -> 'UN1T' defaults). Only keys that resolve to a
 * non-empty string are included, same convention as
 * profileVariables() — a template referencing an unset field falls
 * through to the "still unresolved" path instead of rendering an
 * empty line.
 *
 * @param {object} [opts]
 * @param {object|null} [opts.location] — { name, address, phone, email }
 * @param {object|null} [opts.branding] — { companyName } (from getLocationBranding)
 * @param {object|null} [opts.entity]   — { label } (from getContractingEntity)
 * @returns {Record<string, string>}
 */
export function locationVariables({ location, branding, entity } = {}) {
  const v = {}
  if (location?.name) v.location_name = String(location.name)
  if (location?.address) v.location_address = String(location.address)
  if (location?.phone) v.location_phone = String(location.phone)
  if (location?.email) v.location_email = String(location.email)
  if (branding?.companyName) v.company_name = String(branding.companyName)
  if (entity?.label) v.legal_entity_name = String(entity.label)
  return v
}

/**
 * CONTRACTS-DRAFT.1 — given a contract's stored variables_data and
 * the (possibly stale, possibly null) recipient profile it was
 * issued to, return just the CUSTOM variables an issuer typed in at
 * issue time — i.e. variables_data minus everything profileVariables()
 * would auto-derive from a profile, minus `today` (always
 * regenerated fresh at re-issue time, never carried forward).
 *
 * Used by the re-issue wizard prefill: we want to restore "notice
 * period was 4 weeks" but NOT restore a frozen `full_name`/`today`/
 * salary snapshot that the fresh recipient lookup will re-derive
 * correctly anyway (and that may be stale if the profile changed
 * since the original contract).
 *
 * Pure — no Supabase, no fetch. A null/undefined recipientProfile
 * still strips `today` (it's never a real custom variable) but
 * can't identify any profile-derived keys, so everything else in
 * variablesData passes through untouched.
 *
 * @param {Record<string, unknown>|null|undefined} variablesData
 * @param {object|null} recipientProfile
 * @returns {Record<string, unknown>}
 */
export function customVariablesFrom(variablesData, recipientProfile) {
  if (!variablesData) return {}
  const derivedKeys = new Set(Object.keys(profileVariables(recipientProfile || {})))
  derivedKeys.add('today')
  const out = {}
  for (const [key, value] of Object.entries(variablesData)) {
    if (derivedKeys.has(key)) continue
    out[key] = value
  }
  return out
}

/**
 * Substitute {{variable}} placeholders in the template body with
 * values from the merged map. Unknown placeholders are left as-is
 * so the issuer notices them in the preview and can either fill
 * them in or accept the literal text.
 *
 * Whitespace inside the curly braces is tolerated — `{{ full_name }}`
 * is treated identically to `{{full_name}}`. Variable names are
 * `[a-zA-Z0-9_]+` so we don't accidentally substitute inside e.g.
 * markdown link references.
 */
export function renderTemplate(bodyMarkdown, variables) {
  if (!bodyMarkdown) return ''
  return bodyMarkdown.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (match, key) => {
      if (Object.prototype.hasOwnProperty.call(variables || {}, key)) {
        const v = variables[key]
        return v == null ? '' : String(v)
      }
      // Leave the placeholder visible so the issuer sees it in
      // the preview and can fix the template or supply the value.
      return match
    },
  )
}

/**
 * Validate that every required custom variable in the template's
 * variables_schema has a value supplied by the issuer.
 *
 * Returns { ok: true } on success, or
 * { ok: false, missing: ['key1', 'key2'] } with the list of
 * required keys that weren't provided. The API route uses this to
 * reject incomplete issue requests with a 400 + a helpful message.
 *
 * variables_schema shape (matches the JSONB column):
 *   [
 *     { key: 'notice_period_weeks', label: '...', type: 'number', required: true },
 *     { key: 'commission_rate',     label: '...', type: 'number', required: false },
 *     ...
 *   ]
 */
export function validateCustomVariables(variablesSchema, customVariables) {
  const missing = []
  for (const v of (variablesSchema || [])) {
    if (!v?.required) continue
    const val = customVariables?.[v.key]
    if (val == null || val === '') missing.push(v.key)
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

/**
 * Identify the placeholders actually referenced in the template
 * body. Used by the issue wizard to show the issuer which variables
 * matter for this template, and to warn if the template references
 * something not declared in the schema and not auto-filled from
 * the profile (i.e. would render as literal `{{foo}}` in the
 * final document).
 *
 * Returns an array of unique placeholder names in the order they
 * first appear in the body.
 */
export function extractPlaceholders(bodyMarkdown) {
  if (!bodyMarkdown) return []
  const seen = new Set()
  const out = []
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g
  let m
  while ((m = re.exec(bodyMarkdown)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      out.push(m[1])
    }
  }
  return out
}

/**
 * CONTRACT-VARS.1 — given the template body, the recipient profile,
 * and the issuer-supplied custom variables, return the placeholder
 * keys that would render LITERALLY (i.e. as `{{foo}}`) in the final
 * document — neither auto-fillable from the profile nor supplied as
 * a custom variable.
 *
 * Used both client-side (the wizard surfaces these as inputs) and
 * server-side (the API rejects issue if any remain). Keeping the
 * detection in one place keeps both layers in sync.
 *
 * CONTRACTS-VARS.2 — `opts.assumeKeys` names placeholders that count
 * as resolved regardless of profile/custom values, e.g. the wizard
 * passes LOCATION_VAR_KEYS because it has no way to know the
 * recipient's location fields client-side (they're filled in
 * server-side at issue time — see locationVariables() in the API
 * route). Server-side, location vars are merged into the variable
 * map BEFORE this check runs against the rendered body, so the
 * server never needs assumeKeys — it's a client-only affordance.
 *
 * Returns [] when everything resolves.
 */
export function unresolvedPlaceholders(bodyMarkdown, recipient, customVariables, opts) {
  const assumeKeys = opts?.assumeKeys || []
  const declared = new Set(Object.keys(profileVariables(recipient || {}) || {}))
  for (const k of assumeKeys) declared.add(k)
  for (const k of Object.keys(customVariables || {})) {
    // Only count a key as "supplied" if it has a non-empty value.
    // Empty string or null should still trigger the prompt.
    const v = customVariables[k]
    if (v !== null && v !== undefined && String(v).trim() !== '') {
      declared.add(k)
    }
  }
  return extractPlaceholders(bodyMarkdown).filter((k) => !declared.has(k))
}

// =============================================================
// CONTRACTS-BULK.1 — bulk-issue helpers
// =============================================================

/**
 * Given a set of selected recipients and the full template list,
 * return the templates that are valid for issuing to EVERY
 * recipient in one go — a template qualifies if it's
 * `employment_type === 'both'`, or its employment_type matches
 * a given recipient's employment_type, for ALL recipients.
 *
 * A recipient with a missing/unknown employment_type only matches
 * 'both' templates (mirrors the single-recipient eligibility check
 * the API route enforces — an unknown type never equals a specific
 * template employment_type).
 *
 * Empty recipients → every template is "eligible" (nothing to
 * filter against yet — matches the pre-selection state of the
 * step-1 template dropdown).
 *
 * Pure — no Supabase, no fetch. Recipients only need an
 * `employment_type` field; templates only need `employment_type`.
 *
 * @param {Array<{employment_type?: string|null}>} recipients
 * @param {Array<{employment_type: string}>} templates
 * @returns {Array}
 */
export function eligibleTemplatesFor(recipients, templates) {
  const all = templates || []
  if (!recipients || recipients.length === 0) return all
  return all.filter((t) =>
    recipients.every((r) => t.employment_type === 'both' || t.employment_type === r?.employment_type)
  )
}

/**
 * CONTRACTS-BULK.1 — per-recipient union of unresolvedPlaceholders().
 *
 * Profile-derived auto-fills differ per recipient (e.g. one coach
 * might have `annual_salary` set and another might not), so a bulk
 * issue's "still needs a value" check can't just look at one
 * recipient — a key that resolves fine for recipient A might still
 * render literally for recipient B. This runs unresolvedPlaceholders()
 * once per recipient and unions the results, remembering which
 * recipient(s) each unresolved key belongs to (for the UI to name
 * them in the warning, e.g. "annual_salary (Sarah Doe)").
 *
 * Order: keys appear in first-encountered order (recipient order,
 * then placeholder order within that recipient) — stable for
 * rendering. With a single recipient this reduces to exactly
 * `unresolvedPlaceholders(...)`'s own key list (each entry's
 * `recipients` array has just that one recipient).
 *
 * @param {string} bodyMarkdown
 * @param {Array<object>} recipients
 * @param {Record<string, unknown>} customVariables — shared across recipients
 * @param {{assumeKeys?: string[]}} [opts]
 * @returns {Array<{key: string, recipients: object[]}>}
 */
export function unresolvedPlaceholdersUnion(bodyMarkdown, recipients, customVariables, opts) {
  const order = []
  const byKey = new Map()
  for (const recipient of recipients || []) {
    const keys = unresolvedPlaceholders(bodyMarkdown, recipient, customVariables, opts)
    for (const key of keys) {
      if (!byKey.has(key)) {
        byKey.set(key, [])
        order.push(key)
      }
      byKey.get(key).push(recipient)
    }
  }
  return order.map((key) => ({ key, recipients: byKey.get(key) }))
}

// =============================================================
// Pure status-machine helpers
// =============================================================
// The API route imports these to validate transitions. Keeping
// them here means the test file can pin every legal/illegal
// move without spinning up a Supabase client.

const ALLOWED_TRANSITIONS = {
  draft:    new Set(['issued', 'revoked']),
  issued:   new Set(['viewed', 'signed', 'declined', 'revoked']),
  viewed:   new Set(['signed', 'declined', 'revoked']),
  signed:   new Set([]),    // terminal
  declined: new Set([]),    // terminal
  revoked:  new Set([]),    // terminal
}

/**
 * Returns true if `from` → `to` is a valid status transition.
 * Anything else (including same-status no-ops) returns false.
 */
export function canTransition(from, to) {
  return ALLOWED_TRANSITIONS[from]?.has(to) === true
}

// =============================================================
// CONTRACTS-REMIND.1 — unsigned-contract reminder due-predicate
// =============================================================

const MS_PER_DAY = 1000 * 60 * 60 * 24

// Statuses eligible for a reminder — anything else (draft/signed/
// declined/revoked) is either not yet issued or already resolved.
const REMINDABLE_STATUSES = new Set(['issued', 'viewed'])

// Day-since-issued threshold for each reminder, indexed by the
// contract's CURRENT reminder_count (0 -> first reminder at 3 days,
// 1 -> second/final reminder at 7 days). A count of 2+ has no entry,
// so reminderDue() returns false — the hard cap.
const REMINDER_THRESHOLD_DAYS = [3, 7]

/**
 * Pure due-predicate for the unsigned-contract reminder cron
 * (/api/cron/contract-reminders). Given a contract row (or the
 * subset of fields it needs: status, issued_at, reminder_count) and
 * the current instant, returns true when a reminder should fire now.
 *
 * Rules:
 *   - Only 'issued'/'viewed' contracts are ever reminded.
 *   - reminder_count 0 -> due once issued_at is >= 3 days old.
 *   - reminder_count 1 -> due once issued_at is >= 7 days old.
 *   - reminder_count >= 2 -> never (capped at 2 reminders total).
 *
 * Diffs two Date instants directly via getTime() — no string
 * parsing, so this is timezone-agnostic (issued_at is a UTC
 * timestamptz; "days old" is the same wall-clock-independent
 * duration regardless of the caller's local timezone).
 *
 * @param {object} contract — { status, issued_at, reminder_count }
 * @param {Date|number|string} [now=new Date()]
 * @returns {boolean}
 */
export function reminderDue(contract, now = new Date()) {
  if (!contract) return false
  if (!REMINDABLE_STATUSES.has(contract.status)) return false
  if (!contract.issued_at) return false

  const count = contract.reminder_count || 0
  const thresholdDays = REMINDER_THRESHOLD_DAYS[count]
  if (thresholdDays == null) return false // capped at 2 reminders

  const issuedAt = contract.issued_at instanceof Date ? contract.issued_at : new Date(contract.issued_at)
  const nowDate = now instanceof Date ? now : new Date(now)
  const ageDays = (nowDate.getTime() - issuedAt.getTime()) / MS_PER_DAY
  return ageDays >= thresholdDays
}
