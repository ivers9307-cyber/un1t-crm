// Shared audience filter logic for email campaigns and WhatsApp broadcasts.
//
// Audience filters live in `campaigns.audience_filter` / `whatsapp_broadcasts.audience_filter`
// as JSON of the form:
//   { logic: 'and' | 'or', filters: [{ field, op, value }, ...] }
//
// `field` and `op` originate from user input (the AudienceBuilder UI), so we
// must whitelist both. Allowing an arbitrary field would let a campaign
// author filter on columns we never intended to expose; allowing an arbitrary
// op would let them rewrite the query semantics (e.g. swap `eq` for `not`
// against a raw column path).
//
// The allowlist mirrors src/components/AudienceBuilder.jsx so legitimate UI
// flows pass through unchanged. New fields must be added here AND in the
// builder.

/**
 * Field → { type, ops }. `type` is informational; `ops` is the set of
 * operators valid for that field.
 */
export const AUDIENCE_FIELDS = Object.freeze({
  // Identity / classification
  lead_status:               { type: 'select',  ops: ['eq', 'neq'] },
  email_status:              { type: 'select',  ops: ['eq', 'neq'] },
  lead_source:               { type: 'select',  ops: ['eq', 'neq'] },
  // GLOFOX2.1.8 — Glofox-side membership status (mig 133). Distinct
  // from local lead_status; mirrors Glofox's Client Status with three
  // synthesised canonicals (credit_member, classpass_payg, ex_member).
  // Adds the ability to target Credit Members specifically for
  // subscription-upsell sequences.
  glofox_membership_status:  { type: 'select',  ops: ['eq', 'neq', 'is_null', 'is_not_null', 'not_null'] },
  wa_status:                 { type: 'select',  ops: ['eq', 'neq'] },
  // contacts.sms_status (mig 059) — mirrors wa_status. Used by the
  // upcoming SMS broadcasts/sequences/automations to filter out
  // opted-out / invalid recipients in audience builders.
  sms_status:                 { type: 'select',  ops: ['eq', 'neq'] },
  label:                     { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  tags:                      { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  glofox_member_id:          { type: 'text',    ops: ['eq', 'neq', 'is_null', 'is_not_null', 'not_null'] },

  // Contact identifiers (filtering only — never returned by these queries)
  name:                      { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  first_name:                { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  last_name:                 { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  email:                     { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains'] },
  phone:                     { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  wa_phone:                  { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },

  // Numeric
  trial_credits_remaining:   { type: 'number',  ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null'] },
  total_emails_sent:         { type: 'number',  ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },
  total_emails_opened:       { type: 'number',  ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },
  total_emails_clicked:      { type: 'number',  ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },
  total_wa_sent:             { type: 'number',  ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },
  total_wa_received:         { type: 'number',  ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },

  // Date / timestamp
  created_at:                { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },
  updated_at:                { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'days_since_gt', 'days_since_lt'] },
  lead_created_at:           { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },
  last_emailed_at:           { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },
  last_wa_message_at:        { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },

  // Machine-derived retargeting tags (mig 085). 'tag' compares
  // against contact_tags.tag where removed_at IS NULL. Resolved
  // ASYNC by resolveTagFilters() which pre-fetches the matching
  // contact_ids and the caller injects them as an `id IN (…)`
  // constraint on the contacts query.
  tag:                       { type: 'tag',     ops: ['eq', 'neq'] },
})

const NUMERIC_OPS = new Set(['gt', 'lt', 'gte', 'lte', 'days_since_gt', 'days_since_lt'])

export class InvalidAudienceFilterError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidAudienceFilterError'
  }
}

/**
 * Apply a whitelisted audience filter to a Supabase query.
 *
 * Throws InvalidAudienceFilterError on any unknown field, unsupported op,
 * or unparseable numeric value. Callers should catch this and return 400.
 *
 * @param {object} query  Supabase query builder (already scoped to location + consent)
 * @param {object | null | undefined} filter  { logic, filters: [{ field, op, value }] }
 * @returns {object} Modified query
 */
export function applyAudienceFilter(query, filter) {
  if (!filter?.filters?.length) return query

  if (!Array.isArray(filter.filters)) {
    throw new InvalidAudienceFilterError('audience_filter.filters must be an array')
  }

  for (const f of filter.filters) {
    if (!f || typeof f !== 'object') {
      throw new InvalidAudienceFilterError('Each filter must be an object')
    }

    const { field, op, value } = f
    const fieldConfig = AUDIENCE_FIELDS[field]
    if (!fieldConfig) {
      throw new InvalidAudienceFilterError(`Unknown audience field: ${field}`)
    }
    if (!fieldConfig.ops.includes(op)) {
      throw new InvalidAudienceFilterError(`Operator "${op}" is not allowed on field "${field}"`)
    }

    // 'tag' is a virtual field — it doesn't exist as a column on
    // contacts. resolveTagFilters() must be called first, which
    // pre-fetches the matching contact_ids and the caller injects
    // them as a contacts.id constraint. Skip the tag entries here
    // so the scalar-filter loop doesn't try to apply them as
    // `query.eq('tag', ...)`.
    if (fieldConfig.type === 'tag') continue

    // Parse + validate value where required.
    let v = value
    if (NUMERIC_OPS.has(op) || (fieldConfig.type === 'number' && (op === 'eq' || op === 'neq'))) {
      const n = Number(v)
      if (!Number.isFinite(n)) {
        throw new InvalidAudienceFilterError(`Filter "${field} ${op}" requires a numeric value`)
      }
      v = n
    }

    switch (op) {
      case 'eq':
        query = query.eq(field, v)
        break
      case 'neq':
        query = query.neq(field, v)
        break
      case 'gt':
        query = query.gt(field, v)
        break
      case 'lt':
        query = query.lt(field, v)
        break
      case 'gte':
        query = query.gte(field, v)
        break
      case 'lte':
        query = query.lte(field, v)
        break
      case 'contains':
        query = query.ilike(field, `%${String(v ?? '')}%`)
        break
      case 'not_contains':
        query = query.not(field, 'ilike', `%${String(v ?? '')}%`)
        break
      case 'is_null':
        query = query.is(field, null)
        break
      case 'is_not_null':
      case 'not_null':
        query = query.not(field, 'is', null)
        break
      case 'days_since_gt': {
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - v)
        query = query.lt(field, cutoff.toISOString())
        break
      }
      case 'days_since_lt': {
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - v)
        query = query.gte(field, cutoff.toISOString())
        break
      }
      default:
        // Should be unreachable — fieldConfig.ops gate above catches it,
        // but defend in depth.
        throw new InvalidAudienceFilterError(`Unsupported operator: ${op}`)
    }
  }

  return query
}

/**
 * Resolve any `tag` filters in the audience filter into a contacts.id
 * constraint (Phase 3 — mig 085 retargeting).
 *
 * Tags live on contact_tags (one row per active tag, soft-deleted via
 * removed_at). The audience filter UI exposes `tag eq X` and
 * `tag neq X` — translated here into `contacts.id IN (…)` and
 * `contacts.id NOT IN (…)` respectively. Multiple tag clauses combine
 * with AND inside a single audience filter.
 *
 * Returns the modified query. NULL/empty tag list still applies the
 * constraint (so an `eq` against an unknown tag yields zero rows
 * rather than silently matching everything).
 *
 * @param {object} args
 * @param {SupabaseClient} args.db
 * @param {object} args.query     contacts query already scoped by location
 * @param {object|null} args.filter
 * @param {string|null} args.locationId   tightens the contact_tags lookup
 * @returns {Promise<object>}     the modified query
 */
export async function resolveTagFilters({ db, query, filter, locationId }) {
  if (!filter?.filters?.length) return query

  // Collect the AND-combined positive (eq) and negative (neq) tags.
  const positives = []
  const negatives = []
  for (const f of filter.filters) {
    const cfg = AUDIENCE_FIELDS[f?.field]
    if (!cfg || cfg.type !== 'tag') continue
    if (typeof f.value !== 'string' || !f.value.trim()) {
      throw new InvalidAudienceFilterError('tag filter requires a non-empty string value')
    }
    const tag = f.value.trim()
    if (f.op === 'eq') positives.push(tag)
    else if (f.op === 'neq') negatives.push(tag)
  }
  if (positives.length === 0 && negatives.length === 0) return query

  // Helper: list of contact_ids currently tagged with `tag` at the
  // given location (or all locations if locationId is null).
  async function contactIdsForTag(tag) {
    let q = db.from('contact_tags').select('contact_id').eq('tag', tag).is('removed_at', null)
    if (locationId) q = q.eq('location_id', locationId)
    const { data, error } = await q
    if (error) throw new InvalidAudienceFilterError(`tag lookup failed: ${error.message}`)
    return Array.from(new Set((data || []).map(r => r.contact_id).filter(Boolean)))
  }

  // Positives: intersect across all (AND combine). The first list
  // seeds; subsequent tags filter down. Empty intersection = no rows.
  let allowed = null
  for (const tag of positives) {
    const ids = await contactIdsForTag(tag)
    allowed = allowed === null ? new Set(ids) : new Set([...allowed].filter(x => ids.includes(x)))
    if (allowed.size === 0) {
      // Force an unsatisfiable predicate so the count comes back 0.
      return query.eq('id', '00000000-0000-0000-0000-000000000000')
    }
  }
  if (allowed && allowed.size > 0) {
    query = query.in('id', [...allowed])
  }

  // Negatives: subtract. Use NOT IN (…) — but Supabase JS doesn't
  // support `.not('id', 'in', […])` cleanly across all client
  // versions. Use the OR-string `id.not.in.(…)` form via .or().
  for (const tag of negatives) {
    const ids = await contactIdsForTag(tag)
    if (ids.length === 0) continue // nothing to exclude
    // `id=not.in.(uuid1,uuid2,…)` is the PostgREST URL form. The JS
    // client supports it via the negation chain on .not().
    query = query.not('id', 'in', `(${ids.join(',')})`)
  }

  return query
}

/**
 * Convenience wrapper: resolve tag filters AND apply scalar filters
 * in one call. Use this in async contexts (most route handlers
 * already are). Existing sync callers continue using
 * applyAudienceFilter directly until they need tag support.
 */
export async function applyAudienceFilterAsync({ db, query, filter, locationId }) {
  query = await resolveTagFilters({ db, query, filter, locationId })
  return applyAudienceFilter(query, filter)
}
