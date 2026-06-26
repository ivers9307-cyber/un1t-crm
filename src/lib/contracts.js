// Contracts engine — template variable resolution + render.
//
// Mig 106 introduces `contract_templates` (markdown bodies with
// `{{variable}}` placeholders) and `contracts` (issued instances
// with frozen body + variables_data). This module owns the
// variable-derivation and substitution logic so it can be reused
// from the API route, the email/PDF pipeline, and the unit tests.
//
// Three sources of variables, merged in this priority (later
// wins):
//   1. Profile-derived auto-fills (full_name, email, role, ...)
//   2. Compensation-derived auto-fills (annual_salary, hourly_rate,
//      contracted_rate, contracted_hours_per_week)
//   3. Custom variables provided by the issuer at issue time
//      (declared in the template's variables_schema JSONB).
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
 * Returns [] when everything resolves.
 */
export function unresolvedPlaceholders(bodyMarkdown, recipient, customVariables) {
  const declared = new Set(Object.keys(profileVariables(recipient || {}) || {}))
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
