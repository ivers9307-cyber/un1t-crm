// Shared audience filter logic for email campaigns and WhatsApp broadcasts.
//
// AUDIT P1-2 — the virtual-field resolvers below (tag + event_registration
// + location_list)
// fan out over contact_tags / race_registrations / team_members. At
// Stillorgan's scale (2000+ active contacts, large tag cohorts) a bare
// `.select('contact_id')` silently truncates at the PostgREST 1000-row cap,
// so an audience would be computed from only the first 1000 matches — the
// campaign then sends to the wrong set with NO error. Every such select is
// paginated through selectAll.
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
//
// COMMSFIX.B.1 — negative operators are NULL-INCLUSIVE. Bare PostgREST
// neq / not.ilike / not.cs compile to SQL predicates that a NULL never
// satisfies, so "membership type is not time" silently excluded every
// contact whose type was unsynced (229 live contacts — the 8-Aug sale
// email incident class). Operator intent for "is not X" is "everyone
// except X", so neq / not_contains on scalar AND array fields compile to
// an OR group `(field <op-negated> value OR field IS NULL)`:
//   - AND logic: one `.or('f.neq.v,f.is.null')` per negative filter
//     (chained .or() calls AND together in PostgREST);
//   - OR logic: each negative becomes a nested `or(f.neq.v,f.is.null)`
//     disjunct inside the single top-level .or().

import { selectAll, selectAllByKeys } from '@/lib/select-all'

/**
 * Field → { type, ops }. `type` is informational; `ops` is the set of
 * operators valid for that field.
 */
export const AUDIENCE_FIELDS = Object.freeze({
  // Identity / classification
  //
  // CLASSIFY.1 — pipeline_stage_slug is the canonical funnel position
  // (PIPELINE5 redesign). Denormalised from deals.stage_id →
  // pipeline_stages.slug onto contacts via the trigger in mig 155.
  // Replaces lead_status, which was effectively unmaintained — 99.9%
  // of contacts at Stillorgan had the import default 'active_trial'
  // and no code reliably wrote 'member' or other values back.
  //
  // ORGCONTACTS.4 (decision 3) — the field keeps its name in every saved
  // filter, but the query lands on `column`: the stage AT the audience studio
  // (contact_location_audience.studio_stage_slug / studio_contacts.studio_stage_slug,
  // from contact_studios, migs 765/766), never the contact-wide column, which
  // follows the primary studio's board. is_null now means "no stage at this
  // studio" (a person on the list with no relationship row here).
  pipeline_stage_slug:       { type: 'select',  column: 'studio_stage_slug', ops: ['eq', 'neq', 'is_null', 'is_not_null', 'not_null'] },
  email_status:              { type: 'select',  ops: ['eq', 'neq'] },
  lead_source:               { type: 'select',  ops: ['eq', 'neq'] },
  // GLOFOX2.1.8 — Glofox-side raw membership status. This feeds the
  // pipeline classifier — most operators should NOT filter on it
  // directly; use pipeline_stage_slug instead. Kept as an advanced
  // filter for power users targeting credit_member upsells, classpass
  // _payg cohorts, etc.
  glofox_membership_status:  { type: 'select',  ops: ['eq', 'neq', 'is_null', 'is_not_null', 'not_null'] },
  // CHURN-PREP.2 — the contact's current Glofox membership plan name
  // ("3 Month Membership", "10 Class Pack", ...), synced by the
  // glofox-attendance-refresh cron. Lets operators target a specific
  // plan, or "no membership plan applied" via is_null. The builder
  // populates the value dropdown from /api/contacts/membership-plans.
  glofox_membership_plan:    { type: 'select',  ops: ['eq', 'neq', 'is_null', 'is_not_null', 'not_null'] },
  // GLOFOX-PROFILE (mig 196) — wider Glofox membership profile,
  // synced nightly by glofox-attendance-refresh. Lets campaigns
  // target billing structure and member attributes.
  //   glofox_membership_type — time (subscription) / num_classes
  //                            (class pack) / payg.
  glofox_membership_type:    { type: 'select',  ops: ['eq', 'neq', 'is_null', 'is_not_null', 'not_null'] },
  //   glofox_membership_state — active / paused / locked. 'locked' is a
  //   membership in payment arrears (the churn radar's Overdue tab).
  //   Exposed so operators can build an "overdue" segment that drives a
  //   dunning sequence via the segment_added trigger (RADAR-DUNNING.1).
  glofox_membership_state:   { type: 'select',  ops: ['eq', 'neq', 'is_null', 'is_not_null', 'not_null'] },
  glofox_billing_interval:   { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  glofox_payment_method:     { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  glofox_source:             { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  gender:                    { type: 'select',  ops: ['eq', 'neq', 'is_null', 'is_not_null', 'not_null'] },
  // Boolean Glofox flags. The builder sends 'true' / 'false' strings;
  // applyAudienceFilter coerces them to real booleans.
  glofox_roaming_enabled:    { type: 'boolean', ops: ['eq', 'neq', 'is_null', 'is_not_null', 'not_null'] },
  glofox_account_active:     { type: 'boolean', ops: ['eq', 'neq', 'is_null', 'is_not_null', 'not_null'] },
  wa_status:                 { type: 'select',  ops: ['eq', 'neq'] },
  // contacts.sms_status (mig 059) — mirrors wa_status. Used by the
  // upcoming SMS broadcasts/sequences/automations to filter out
  // opted-out / invalid recipients in audience builders.
  sms_status:                 { type: 'select',  ops: ['eq', 'neq'] },
  label:                     { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  // contacts.tags is text[] — `array: true` routes it through the
  // array-operator branch (PostgREST `cs`); the scalar eq/ilike the
  // other text fields use are a PostgREST 400 on an array column.
  tags:                      { type: 'text',    array: true, ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  glofox_member_id:          { type: 'text',    ops: ['eq', 'neq', 'is_null', 'is_not_null', 'not_null'] },
  // GYMPASS.1 (mig 429) — Gympass (Wellhub) member id, lifted from the
  // Glofox profile's metadata.gympass block by the member sync. Presence
  // (not_null) = an active Gympass user, so operators can build a Gympass
  // audience segment ("Gympass Member exists"). ClassPass stays targetable
  // via glofox_membership_status = classpass_payg.
  gympass_member_id:         { type: 'text',    ops: ['eq', 'neq', 'is_null', 'is_not_null', 'not_null'] },

  // Contact identifiers (filtering only — never returned by these queries)
  name:                      { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  first_name:                { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  last_name:                 { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  email:                     { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains'] },
  phone:                     { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  wa_phone:                  { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },
  // GLOFOX-PROFILE (mig 196) — emergency contact string. Mainly
  // useful via is_null / not_null to find members missing one.
  emergency_contact:         { type: 'text',    ops: ['eq', 'neq', 'contains', 'not_contains', 'is_null', 'is_not_null', 'not_null'] },

  // Numeric
  //
  // FILTER-C.1 — `notNull: true` marks a counter the SCHEMA guarantees can
  // never be NULL (mig 519 backfills 0 and pins SET NOT NULL). It is why these
  // fields carry no is_null / is_not_null, unlike every date field: with the
  // guarantee, "never opened" is exactly `= 0` and there is no second,
  // invisible cohort — the NULL-dropping class COMMSFIX.B.1 and FILTER-P1.2
  // spent their time removing.
  //
  // The alternative (add the null ops) was rejected on the live evidence: at
  // 2026-08-10 all ten counters were DEFAULT 0 with ZERO NULLs across 8,572
  // contacts, and every writer coalesces (`?? 0`). Offering "opened is empty"
  // would have shipped an operator-visible filter that matches nobody and
  // cannot say why — a new trap of the same family, not a fix for the old one.
  // audience-filter-counter-nullability.test.js keeps this marker, the op list
  // and mig 519 in step. Nullable numbers (trial_credits_remaining: 6,530
  // NULLs live; glofox_membership_price_cents: 4,886) keep the null ops.
  trial_credits_remaining:   { type: 'number',  ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null'] },
  total_emails_sent:         { type: 'number',  notNull: true, ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },
  // GLOFOX2.1.14 — booking aggregates (mig 137). Powers re-engagement
  // audiences ("haven't attended in N days") and welcome sequences
  // ("first attendance"). Refreshed by per-member sync + future
  // BOOKING_* webhook handler + daily cron safety net.
  total_bookings_30d:        { type: 'number',  notNull: true, ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },
  total_attended_30d:        { type: 'number',  notNull: true, ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },
  total_noshow_30d:          { type: 'number',  notNull: true, ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },
  // GLOFOX2.1.20 — Lifetime Value from INVOICE_UPDATED webhook
  // (mig 140). Powers VIP segmentation, at-risk audiences (high
  // LTV + lapsed), and revenue-cohort analysis.
  // Stored as cents (BIGINT) so the operator filters with
  // "lifetime_value_cents > 50000" (= €500).
  lifetime_value_cents:        { type: 'number',  notNull: true, ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },
  lifetime_transaction_count:  { type: 'number',  notNull: true, ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },
  // GLOFOX-PROFILE (mig 196) — effective membership price in cents.
  // Powers price-band targeting (premium-tier upsell, win-back of
  // lapsed high-value plans).
  glofox_membership_price_cents: { type: 'number', ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null'] },
  total_emails_opened:       { type: 'number',  notNull: true, ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },
  total_emails_clicked:      { type: 'number',  notNull: true, ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },
  total_wa_sent:             { type: 'number',  notNull: true, ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },
  total_wa_received:         { type: 'number',  notNull: true, ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'] },

  // Date / timestamp
  created_at:                { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },
  updated_at:                { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'days_since_gt', 'days_since_lt'] },
  lead_created_at:           { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },
  // GLOFOX2.1.13 — joined_at (mig 136). Glofox-side tenure date —
  // operator-set during imports (can be backdated), falls back to
  // Glofox row-creation timestamp. Powers anniversary campaigns
  // and cohort analysis.
  joined_at:                 { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },
  // GLOFOX2.1.14 — booking-engagement timestamps (mig 137).
  last_booked_at:            { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },
  last_attended_at:          { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },
  // GLOFOX2.1.20 — payment-activity timestamps.
  last_payment_at:           { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },
  last_invoice_at:           { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },
  // GLOFOX-PROFILE (mig 196) — membership renewal / expiry date.
  // Powers renewal-window campaigns ("renews before <date>") and
  // win-back of recently expired memberships.
  glofox_membership_expiry:  { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },
  last_emailed_at:           { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },
  // GAPS-P1 (mig 511) — engagement RECENCY, as distinct from
  // last_emailed_at, which only says whether WE emailed them.
  // Maintained on every Postmark Open/Click and equal to
  // max(email_sends.opened_at) / max(clicked_at) per contact. These
  // are what an "opened in the last 30 days" segment needs
  // (days_since_lt), and last_email_open_at is also the inactivity
  // cron's stored signal — it was driven for months as a column that
  // did not exist (see mig 511's header).
  last_email_open_at:        { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },
  last_email_click_at:       { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },
  last_wa_message_at:        { type: 'date',    ops: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null', 'not_null', 'days_since_gt', 'days_since_lt'] },

  // Machine-derived retargeting tags (mig 085). 'tag' compares
  // against contact_tags.tag where removed_at IS NULL. Resolved
  // ASYNC by resolveTagFilters() which pre-fetches the matching
  // contact_ids and the caller injects them as an `id IN (…)`
  // constraint on the contacts query.
  tag:                       { type: 'tag',     ops: ['eq', 'neq'] },

  // EVENT-FILTER — virtual field. 'event_registration' is not a
  // contacts column; resolveEventFilters() pre-fetches the contact_ids
  // registered for the chosen event (race_registrations.status IN
  // pending_payment/confirmed, registrants + linked teammates) and the
  // caller injects them as an id IN (…) constraint. The builder's value
  // is a race_events UUID. eq = registered for; neq = not registered for.
  event_registration:        { type: 'event',   ops: ['eq', 'neq'] },

  // LISTFILTER.1 — virtual field. 'location_list' is not a contacts column;
  // resolveLocationListFilters() pre-fetches the contact_ids holding a
  // contact_location_preferences row at the chosen studio and the caller
  // injects them as an id IN (…) constraint. Value is a locations UUID.
  // eq = on that studio's list; neq = not on it.
  //
  // MEMBERSHIP, NOT MAILABILITY. The predicate is the PRESENCE of the
  // preferences row, which under the per-location comms model is what makes
  // a studio allowed to mail that person at all — deliberately NOT
  // `email_marketing = true`. The send path applies consent itself (the
  // audience view is already gated on the consent column for the sending
  // location), so folding it in here would double-gate the sender and, worse,
  // would quietly answer a different question than the one the operator
  // asked: "who is on the Hatch list" is a roll-call, not a send estimate.
  location_list:             { type: 'location_list', ops: ['eq', 'neq'] },

  // PILLAR2 — explicit recipients. Deliberately NOT in AudienceBuilder's
  // FIELD_OPTIONS (operators don't filter on raw UUIDs): the unified send
  // composer's "pick people" mode constructs `{ field:'id', op:'in',
  // value:[contactId,…] }` directly. The send + count paths apply it on top of
  // the consent/status gates, so opted-out / invalid contacts are still excluded.
  id:                        { type: 'id',      ops: ['in'] },
})

// EVENT-FILTER — registration statuses that count as a LIVE registration
// for audience targeting. pending_payment = signed up, checkout not yet
// completed; confirmed = paid (or a free event). Deliberately EXCLUDES
// 'cancelled' (operator removed) and 'no_show' (post-event) — mirrors the
// capacity predicate used at signup time (events/[slug]/register).
export const LIVE_REGISTRATION_STATUSES = Object.freeze(['pending_payment', 'confirmed'])

// Union a live event's registrants (race_registrations.contact_id) with
// the linked teammates on those registrations' teams
// (team_members.contact_id) into a de-duplicated array of contact ids.
// NULL contact_ids (un-linked teammates) are dropped — no contact row,
// unreachable by any channel.
export function mergeRegistrationContactIds(registrations, teamMembers) {
  const ids = new Set()
  for (const r of registrations || []) if (r?.contact_id) ids.add(r.contact_id)
  for (const m of teamMembers || []) if (m?.contact_id) ids.add(m.contact_id)
  return Array.from(ids)
}

// Ops whose value is a day-count number ("more/less than N days ago").
// Always numeric, whatever the field type.
const DAYS_SINCE_OPS = new Set(['days_since_gt', 'days_since_lt'])
// Plain comparison ops. Numeric ONLY on number-typed fields — on a
// date field these carry an ISO date string (Number('2026-07-01') is
// NaN), so coercing by op alone wrongly rejects date before/after.
const NUMERIC_COMPARE_OPS = new Set(['gt', 'lt', 'gte', 'lte'])
// InvalidAudienceFilterError and the id-list URL budget live below, next to
// the virtual-field resolvers that raise them (AUDIENCEIDS.1).

// FILTER-P1.1 — an UNSET builder row: the operator clicked "Add filter" but
// has not chosen a field yet ({ field: '', op: '', value: '' }).
//
// Before this, addFilter() seeded every new row with `Stage = member`. In the
// send composer that was a defensible guess; in a sequence it was not —
// SEQEXIT.1 made the audience filter a CONTINUING condition, re-checked before
// every step, so one click of "Add filter" both restricted enrolment to
// members AND exited every non-member mid-sequence. The host now supplies the
// default; with none, the row starts unset and must be INERT: no predicate, no
// validation error, no persisted meaning. Only a BLANK field is skipped — any
// other unrecognised field still throws (a typo must never widen an audience).
export function isUnsetFilterRow(f) {
  return !f || typeof f !== 'object' || f.field == null || f.field === ''
}

// Drop unset rows before a filter leaves the builder for the count endpoint or
// the database, so neither ever sees a half-built row.
export function stripUnsetFilterRows(filter) {
  if (!filter || !Array.isArray(filter.filters)) return filter
  return { ...filter, filters: filter.filters.filter(f => !isUnsetFilterRow(f)) }
}

// ── OR support (PostgREST .or()) ─────────────────────────────────
// When filter.logic === 'or', the scalar predicates must be combined with
// OR, not chained (chaining ANDs). PostgREST expresses OR as a single
// .or('cond1,cond2,…') call. These helpers translate one validated filter
// into its PostgREST condition string. Values containing the or-string's
// reserved chars (comma / parens / quotes) are double-quoted + escaped.

function orValue(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const s = String(v ?? '')
  if (/[,()"\\]/.test(s)) return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return s
}

function orIlikePattern(v) {
  const pat = `%${String(v ?? '')}%`
  // % is not a reserved char; only quote if the value itself carries one.
  if (/[,()"\\]/.test(pat)) return `"${pat.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return pat
}

// Postgres array literal for a single element, for `cs` filters on a
// text[] column ({"PTC"}). Always quoted so commas/braces in a tag
// can't be parsed as separators.
function pgArrayLiteral(v) {
  const s = String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `{"${s}"}`
}

// Array-typed columns (fieldConfig.array) — element membership is the
// only comparison that makes sense for a tag, so eq and contains both
// mean "has this tag" (cs) and neq/not_contains mean "doesn't" —
// scalar eq/ilike on a text[] column is a PostgREST 400.
function applyArrayFieldOp(query, field, op, v) {
  switch (op) {
    case 'eq':
    // FILTER-P1.3 — `contains` is the SAME operation as `eq` here (exact
    // element membership, not substring: typing "PT" never finds "PTC").
    // The builder no longer offers both, but the server keeps accepting the
    // old name so filters saved under it still resolve identically.
    case 'contains':
      return query.contains(field, [String(v ?? '')])
    case 'neq':
    case 'not_contains':
      // COMMSFIX.B.1 — NULL-inclusive: "doesn't have this tag" must also
      // match contacts whose tags column is NULL (never tagged at all).
      return query.or(`${field}.not.cs.${orValue(pgArrayLiteral(v))},${field}.is.null`)
    // FILTER-P1.3 — REAL emptiness, not a NULL test. contacts.tags is
    // TEXT[] DEFAULT '{}' (mig 005), so `.is(field, null)` matched almost
    // nobody and `.not(field,'is',null)` matched almost everybody — both
    // silent, both wrong. `cd` (contained-by) against the empty array is
    // true only for an empty array, which is what "has no tags" means.
    // NULL is folded in on the empty side because a never-tagged contact
    // has no tags either; on the non-empty side a NULL row fails
    // `not.cd.{}` on its own (NULL <@ '{}' is NULL), so no extra clause.
    case 'is_null':
      return query.or(`${field}.cd.{},${field}.is.null`)
    case 'is_not_null':
    case 'not_null':
      return query.not(field, 'cd', '{}')
    default:
      throw new InvalidAudienceFilterError(`Operator "${op}" is not supported on array field "${field}"`)
  }
}

// Build the PostgREST condition string for one validated (field, op, v).
// Mirrors the AND switch in applyAudienceFilter exactly.
function toOrCondition(field, op, v, fieldConfig) {
  if (fieldConfig?.array) {
    switch (op) {
      case 'eq':
      case 'contains':
        return `${field}.cs.${orValue(pgArrayLiteral(v))}`
      case 'neq':
      case 'not_contains':
        // COMMSFIX.B.1 — NULL-inclusive nested disjunct.
        return `or(${field}.not.cs.${orValue(pgArrayLiteral(v))},${field}.is.null)`
      // FILTER-P1.3 — real emptiness; see applyArrayFieldOp for the reasoning.
      case 'is_null':
        return `or(${field}.cd.{},${field}.is.null)`
      case 'is_not_null':
      case 'not_null':
        return `${field}.not.cd.{}`
      default:
        throw new InvalidAudienceFilterError(`Operator "${op}" is not supported on array field "${field}"`)
    }
  }
  switch (op) {
    case 'eq': return `${field}.eq.${orValue(v)}`
    // COMMSFIX.B.1 — NULL-inclusive negatives as nested or() groups.
    case 'neq': return `or(${field}.neq.${orValue(v)},${field}.is.null)`
    case 'gt': return `${field}.gt.${orValue(v)}`
    case 'lt': return `${field}.lt.${orValue(v)}`
    case 'gte': return `${field}.gte.${orValue(v)}`
    case 'lte': return `${field}.lte.${orValue(v)}`
    case 'in':
      if (!Array.isArray(v)) throw new InvalidAudienceFilterError(`Filter "${field} in" requires an array value`)
      // Empty selection → an always-false disjunct (contributes nothing).
      return v.length === 0
        ? `${field}.eq.00000000-0000-0000-0000-000000000000`
        : `${field}.in.(${v.map(orValue).join(',')})`
    case 'contains': return `${field}.ilike.${orIlikePattern(v)}`
    case 'not_contains': return `or(${field}.not.ilike.${orIlikePattern(v)},${field}.is.null)`
    case 'is_null': return `${field}.is.null`
    case 'is_not_null':
    case 'not_null': return `${field}.not.is.null`
    // FILTER-P1.2 — NULL-INCLUSIVE, as a nested or() disjunct. See the
    // asymmetry note on the AND branch in applyAudienceFilter.
    case 'days_since_gt': {
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - v)
      return `or(${field}.lt.${cutoff.toISOString()},${field}.is.null)`
    }
    // FILTER-P1.2 — NULL-EXCLUSIVE on purpose. Do not add `.is.null` here.
    case 'days_since_lt': {
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - v)
      return `${field}.gte.${cutoff.toISOString()}`
    }
    default:
      throw new InvalidAudienceFilterError(`Unsupported operator: ${op}`)
  }
}

/**
 * Apply a whitelisted audience filter to a Supabase query.
 *
 * Honours filter.logic: 'and' (default) chains predicates; 'or' combines them
 * with a single PostgREST .or(). OR is not supported together with tag/event
 * virtual filters (those resolve to AND-combined id-sets) — that combination
 * throws rather than silently producing the wrong audience.
 *
 * Throws InvalidAudienceFilterError on any unknown field, unsupported op,
 * or unparseable numeric value. Callers should catch this and return 400.
 *
 * @param {object} query  Supabase query builder (already scoped to location + consent)
 * @param {object | null | undefined} filter  { logic, filters: [{ field, op, value }] }
 * @param {{ fields?: object }} [opts]  `fields`: the registry to validate against
 *   (default AUDIENCE_FIELDS). ORGCONTACTS.4: the segment change report
 *   evaluates one filter against two registries (the contact-wide stage and
 *   the stage at the studio); every send path passes nothing.
 * @returns {object} Modified query
 */
export function applyAudienceFilter(query, filter, { fields = AUDIENCE_FIELDS } = {}) {
  if (filter == null) return query

  // FILTER-A.5 / FILTER-FOUND row 4 — `logic` was never validated. The
  // `filter.logic === 'or'` test below means ANY, and EVERYTHING ELSE meant
  // AND: 'OR', 'Or', 'any', a typo, a number. So a filter that was built to
  // mean ANY and arrived spelled 'OR' silently became ALL — a strictly
  // narrower audience, produced with no error anywhere, which is precisely the
  // failure mode this programme exists to remove. Checked BEFORE the
  // empty-filters early return, so a broken logic cannot be persisted on a
  // filter that merely has no rows yet and then start lying once rows arrive.
  if (filter.logic != null && filter.logic !== 'and' && filter.logic !== 'or') {
    throw new InvalidAudienceFilterError(
      `audience_filter.logic must be "and" or "or" (got ${JSON.stringify(filter.logic)})`,
    )
  }

  if (!filter.filters?.length) return query

  if (!Array.isArray(filter.filters)) {
    throw new InvalidAudienceFilterError('audience_filter.filters must be an array')
  }

  const useOr = filter.logic === 'or'
  const orParts = []

  for (const f of filter.filters) {
    if (!f || typeof f !== 'object') {
      throw new InvalidAudienceFilterError('Each filter must be an object')
    }

    // FILTER-P1.1 — a row with no field chosen yet is inert, not an error.
    if (isUnsetFilterRow(f)) continue

    const { field: fieldName, op, value } = f
    const fieldConfig = fields[fieldName]
    if (!fieldConfig) {
      throw new InvalidAudienceFilterError(`Unknown audience field: ${fieldName}`)
    }
    if (!fieldConfig.ops.includes(op)) {
      throw new InvalidAudienceFilterError(`Operator "${op}" is not allowed on field "${fieldName}"`)
    }
    // The column the predicate lands on: the field's own name unless the
    // registry maps it elsewhere (`column`, ORGCONTACTS.4).
    const field = fieldConfig.column ?? fieldName

    // 'tag' / 'event' are virtual fields resolved separately (resolveTag/
    // EventFilters) into AND-combined contacts.id constraints. They cannot
    // participate in an OR disjunction with the scalar predicates, so under
    // OR logic we fail loudly rather than silently dropping them (which
    // would widen the audience to everyone matching the scalar OR).
    if (fieldConfig.type === 'tag' || fieldConfig.type === 'event' || fieldConfig.type === 'location_list') {
      if (useOr) {
        throw new InvalidAudienceFilterError(
          'OR logic is not supported together with tag, event or studio-list filters. Use AND, or send these as separate audiences.'
        )
      }
      // AND: skip here — the scalar-filter loop must not apply a virtual
      // field as `query.eq('tag', …)`; the resolver injected its id-set.
      continue
    }

    // Parse + validate value where required.
    let v = value
    const wantsNumber = DAYS_SINCE_OPS.has(op)
      || (fieldConfig.type === 'number'
          && (NUMERIC_COMPARE_OPS.has(op) || op === 'eq' || op === 'neq'))
    if (wantsNumber) {
      // COMMSFIX.B.2 — Number('') / Number(null) are 0 and Number(true) is 1,
      // so a blank builder row silently became "= 0" (a large real cohort)
      // and "more than [blank] days ago" meant "ever". Reject them before
      // the coercion; only real numbers / numeric strings pass.
      if (v === '' || v === null || v === undefined || typeof v === 'boolean') {
        throw new InvalidAudienceFilterError(`Filter "${field} ${op}" requires a numeric value`)
      }
      const n = Number(v)
      if (!Number.isFinite(n)) {
        throw new InvalidAudienceFilterError(`Filter "${field} ${op}" requires a numeric value`)
      }
      v = n
    }
    // FILTER-P1.4 — date fields compared against a real date, or nothing.
    // gt/lt on a date field with value '' passed validation, persisted onto
    // the campaign, and only surfaced at SEND time as a raw Postgres
    // `invalid input syntax for type timestamp`. The builder CREATED that
    // state: switching a row to a date field defaulted to 'after' with an
    // empty value. Reject it here so the count 400s visibly and
    // validateAudienceFilter (which reuses this) refuses to save it.
    // days_since_* are excluded — they carry a day COUNT, already guarded
    // by the numeric branch above.
    if (fieldConfig.type === 'date'
        && !DAYS_SINCE_OPS.has(op)
        && (NUMERIC_COMPARE_OPS.has(op) || op === 'eq' || op === 'neq')) {
      if (typeof v !== 'string' || !v.trim() || Number.isNaN(Date.parse(v))) {
        throw new InvalidAudienceFilterError(`Filter "${field} ${op}" requires a date value`)
      }
    }
    // Boolean fields — the builder sends 'true' / 'false' strings.
    // Coerce to a real boolean for eq / neq; reject anything else.
    if (fieldConfig.type === 'boolean' && (op === 'eq' || op === 'neq')) {
      if (v === true || v === 'true') v = true
      else if (v === false || v === 'false') v = false
      else throw new InvalidAudienceFilterError(`Filter "${field} ${op}" requires a boolean value`)
    }

    // OR logic — accumulate a PostgREST condition string instead of
    // chaining (which would AND). Applied once after the loop.
    if (useOr) {
      orParts.push(toOrCondition(field, op, v, fieldConfig))
      continue
    }

    if (fieldConfig.array) {
      query = applyArrayFieldOp(query, field, op, v)
      continue
    }

    switch (op) {
      case 'eq':
        query = query.eq(field, v)
        break
      case 'neq':
        // COMMSFIX.B.1 — NULL-inclusive "is not": chained .or() calls AND
        // together in PostgREST, so this stays an AND-composed predicate.
        query = query.or(`${field}.neq.${orValue(v)},${field}.is.null`)
        break
      case 'in': {
        if (!Array.isArray(v)) {
          throw new InvalidAudienceFilterError(`Filter "${field} in" requires an array value`)
        }
        // Empty selection → unsatisfiable predicate (count 0), mirroring the
        // tag-filter zero-intersection guard.
        query = v.length === 0
          ? query.eq(field, '00000000-0000-0000-0000-000000000000')
          : query.in(field, v)
        break
      }
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
        // COMMSFIX.B.1 — NULL-inclusive "does not contain".
        query = query.or(`${field}.not.ilike.${orIlikePattern(v)},${field}.is.null`)
        break
      case 'is_null':
        query = query.is(field, null)
        break
      case 'is_not_null':
      case 'not_null':
        query = query.not(field, 'is', null)
        break
      // FILTER-P1.2 — THE ASYMMETRY BELOW IS DELIBERATE. Do not "tidy" it
      // into symmetry; each direction means something different about a NULL.
      //
      // days_since_gt = "more than N days ago" → NULL-INCLUSIVE.
      //   Product decision: "more than N days ago" MEANS "or never". A
      //   contact with no last_attended_at has not attended in 30 days, and
      //   dropping them removes precisely the cohort a re-engagement send
      //   exists for. The bare .lt() this replaced is the same NULL-dropping
      //   bug class COMMSFIX.B.1 fixed for neq, never extended to date ops;
      //   there is no operator workaround because the AND/OR toggle is global.
      //   Chained .or() calls AND together in PostgREST, so this stays an
      //   AND-composed predicate exactly like the neq case above.
      case 'days_since_gt': {
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - v)
        query = query.or(`${field}.lt.${cutoff.toISOString()},${field}.is.null`)
        break
      }
      // days_since_lt = "less than N days ago" → NULL-EXCLUSIVE, unchanged.
      //   Never-happened does NOT satisfy "happened recently". Adding
      //   `.is.null` here would silently widen every "recently active"
      //   audience to the whole list — the inverse of the gt bug.
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

  // OR: combine every accumulated scalar predicate into one .or() so they
  // match ANY (not ALL). A single condition still works via .or().
  if (useOr && orParts.length) {
    query = query.or(orParts.join(','))
  }

  return query
}

/**
 * AUDIENCEIDS.1 — how a resolved contact-id set reaches the database.
 *
 * The three virtual fields below (`tag`, `event_registration`,
 * `location_list`) are resolved in JS into contact-id sets. Until 31 Oct 2026
 * every set was placed on the PostgREST GET URL as `id=in.(…)` or
 * `id=not.in.(…)`, bounded by a COUNT (MAX_EXCLUSION_IDS = 2000). The limit
 * is URL bytes, not rows: a uuid costs 39 URL characters (36 + the encoded
 * comma), so 1,902 excluded ids was a ~74 KB URL that failed before PostgREST
 * answered — supabase-js resolved `{ error }` with an EMPTY message, the
 * campaign-sender wrote "audience load failed: " and the run-campaigns cron
 * marked the Stillorgan Lock-In Sale campaign failed, every tick.
 *
 * Now:
 *  - the sets of every virtual field are merged FIRST (positives intersect
 *    across fields, negatives union; a known inclusion has its exclusions
 *    subtracted in JS, so at most ONE id predicate is ever emitted);
 *  - the predicate's encoded URL length is measured against
 *    AUDIENCE_ID_URL_BUDGET. Under budget → the GET path, unchanged;
 *  - over budget → the caller's `rebase({ include, exclude })` rebuilds the
 *    same base query on the relation's `*_scoped` rpc twin (mig 795), which
 *    takes the ids in the POST body and returns the relation's rows, so
 *    .eq()/.order()/.range()/count all still apply and the `{ query }`
 *    contract holds. See scopedAudienceSource;
 *  - over budget with no `rebase` → a loud InvalidAudienceFilterError that
 *    says how long the URL would be, never an empty-message failure.
 */

// Characters of encoded `id=in.(…)` / `id=not.in.(…)` an audience query may
// carry on its GET URL. 8,000 is supabase-js's own default `urlLengthLimit`
// (the length at which it starts warning about `.in()` lists). A uuid costs
// 39 of them, so this is ~205 uuids; the live failure was 1,902.
export const AUDIENCE_ID_URL_BUDGET = 8_000

// How many uuids an `id=in.(…)` predicate holds inside that budget: 9 chars of
// `id=in.%28` + `%29`, then 36 for each uuid and 3 for each encoded comma.
// For a caller that chunks a known uuid list itself (the resend populate's
// non-opener ids), never a bare 1,000.
export const MAX_UUIDS_PER_URL = Math.floor((AUDIENCE_ID_URL_BUDGET - 12) / 39)

// Unsatisfiable predicate: an inclusion that resolved to nobody must return 0
// rows (and count 0), never "everyone".
const NOBODY_ID = '00000000-0000-0000-0000-000000000000'

export class InvalidAudienceFilterError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidAudienceFilterError'
  }
}

/**
 * The exact number of URL characters postgrest-js would add for an id
 * predicate over `ids` (`.in('id', ids)` or `.not('id', 'in', '(…)')`):
 * URLSearchParams encodes `(`, `)` and `,` as three characters each.
 */
export function idPredicateUrlLength(ids, { negate = false } = {}) {
  const list = Array.isArray(ids) ? ids : Array.from(ids)
  const value = `${negate ? 'not.' : ''}in.(${list.join(',')})`
  return new URLSearchParams([['id', value]]).toString().length
}

// Fast-path: does the filter name any virtual field at all? Lets every caller
// skip the merge (and the rebase closure) when there is nothing to resolve.
function virtualClauses(filter) {
  if (!filter?.filters?.length) return []
  return filter.filters.filter(f => {
    const cfg = AUDIENCE_FIELDS[f?.field]
    return cfg && (cfg.type === 'tag' || cfg.type === 'event' || cfg.type === 'location_list')
  })
}

function partitionClauses(filter, type, { onEmpty }) {
  const positives = []
  const negatives = []
  for (const f of filter?.filters || []) {
    const cfg = AUDIENCE_FIELDS[f?.field]
    if (!cfg || cfg.type !== type) continue
    if (typeof f.value !== 'string' || !f.value.trim()) {
      throw new InvalidAudienceFilterError(onEmpty)
    }
    const value = f.value.trim()
    if (f.op === 'eq') positives.push(value)
    else if (f.op === 'neq') negatives.push(value)
  }
  return { positives, negatives }
}

// Intersect `acc` (null = unconstrained so far) with `ids`.
function intersect(acc, ids) {
  if (acc === null) return new Set(ids)
  const idSet = ids instanceof Set ? ids : new Set(ids)
  return new Set([...acc].filter(x => idSet.has(x)))
}

/**
 * Resolve ONE field's clauses into `{ include: Set|null, exclude: Set }`,
 * given a loader from the field's value to the matching contact ids.
 */
async function idSetsFor({ filter, type, onEmpty, load }) {
  const { positives, negatives } = partitionClauses(filter, type, { onEmpty })
  let include = null
  for (const value of positives) {
    include = intersect(include, await load(value))
    if (include.size === 0) break   // nothing can widen an empty intersection
  }
  const exclude = new Set()
  if (include === null || include.size > 0) {
    for (const value of negatives) {
      for (const id of await load(value)) exclude.add(id)
    }
  }
  return { include, exclude }
}

// Helper: list of contact_ids currently tagged with `tag` at the given
// location (or all locations if locationId is null).
// AUDIT P1-2 — paginated: a popular tag can match >1000 contacts, and a
// truncated set silently narrows the audience. selectAll throws a plain
// Error on a DB failure; re-wrap as InvalidAudienceFilterError so the
// caller's existing 400 path is preserved.
async function contactIdsForTag(db, tag, locationId) {
  let data
  try {
    data = await selectAll((from, to) => {
      let q = db.from('contact_tags').select('contact_id').eq('tag', tag).is('removed_at', null)
      if (locationId) q = q.eq('location_id', locationId)
      return q.order('contact_id', { ascending: true }).range(from, to)
    })
  } catch (err) {
    throw new InvalidAudienceFilterError(`tag lookup failed: ${err.message}`)
  }
  return Array.from(new Set(data.map(r => r.contact_id).filter(Boolean)))
}

// contact_ids registered (live) for one event: registrants + teammates.
// AUDIT P1-2 — both selects paginated: a large event's registration list
// (+ the teammate fan-out across many teams) can exceed the 1000-row cap,
// which would silently drop registrants past row 1000 from the audience.
// The team-id list is chunked too (selectAllByKeys, 300 a query): it rides
// the GET URL exactly like the contact-id lists this file exists to bound.
// selectAll throws a plain Error; re-wrap as InvalidAudienceFilterError.
async function contactIdsForEvent(db, eventId) {
  let regs
  try {
    regs = await selectAll((from, to) => db
      .from('race_registrations')
      .select('contact_id, team_id')
      .eq('race_event_id', eventId)
      .in('status', LIVE_REGISTRATION_STATUSES)
      .order('id', { ascending: true })
      .range(from, to))
  } catch (err) {
    throw new InvalidAudienceFilterError(`event lookup failed: ${err.message}`)
  }

  const teamIds = Array.from(new Set(regs.map(r => r.team_id).filter(Boolean)))
  let members = []
  if (teamIds.length) {
    try {
      members = await selectAllByKeys(teamIds, (keys, from, to) => db
        .from('team_members')
        .select('contact_id')
        .in('team_id', keys)
        .not('contact_id', 'is', null)
        .order('contact_id', { ascending: true })
        .range(from, to))
    } catch (err) {
      throw new InvalidAudienceFilterError(`event teammate lookup failed: ${err.message}`)
    }
  }
  return mergeRegistrationContactIds(regs, members)
}

// LISTFILTER.1 — everyone holding a contact_location_preferences row at the
// studio. Paginated for the same reason the tag + event loaders are: a
// studio's preference-row set runs to thousands (Stillorgan alone is 7k+),
// and the 1,000-row select cap applies regardless of .limit(). A truncated
// set here does not error — it silently narrows the audience, which on a send
// path means people quietly not receiving something.
async function contactIdsOnList(db, locationId) {
  let rows
  try {
    rows = await selectAll((from, to) => db
      .from('contact_location_preferences')
      .select('contact_id')
      .eq('location_id', locationId)
      .order('contact_id', { ascending: true })
      .range(from, to))
  } catch (err) {
    throw new InvalidAudienceFilterError(`studio-list lookup failed: ${err.message}`)
  }
  return [...new Set(rows.map(r => r?.contact_id).filter(Boolean))]
}

const TAG_EMPTY = 'tag filter requires a non-empty string value'
const EVENT_EMPTY = 'event filter requires a non-empty event id'
const LIST_EMPTY = 'studio-list filter requires a non-empty location id'

/** `tag eq X` / `tag neq X` → id sets (mig 085 retargeting tags). */
export async function tagIdSets({ db, filter, locationId }) {
  return idSetsFor({ filter, type: 'tag', onEmpty: TAG_EMPTY, load: (tag) => contactIdsForTag(db, tag, locationId) })
}

/**
 * `event_registration eq X` / `neq X` → id sets. "Registered for event X" =
 * race_registrations rows for X whose status is a LIVE_REGISTRATION_STATUS
 * (pending_payment or confirmed), taking the registrant UNION the linked
 * teammates on those registrations' teams. cancelled + no_show are excluded.
 */
export async function eventIdSets({ db, filter }) {
  return idSetsFor({ filter, type: 'event', onEmpty: EVENT_EMPTY, load: (eventId) => contactIdsForEvent(db, eventId) })
}

/**
 * LISTFILTER.1 — `location_list eq X` / `neq X` → id sets. Answers "who is on
 * <studio>'s list" by ROW PRESENCE in contact_location_preferences, which the
 * deal-keyed crossover machinery cannot: a person who registered interest at a
 * pre-opening studio holds no deal there, only a preferences row.
 *
 * MEMBERSHIP, NOT MAILABILITY — deliberately NOT `email_marketing = true`. The
 * send path applies consent itself (the audience view is already gated on the
 * consent column for the sending location); folding it in here would
 * double-gate the sender and quietly answer a different question than the one
 * the operator asked: "who is on the Hatch list" is a roll-call, not a send
 * estimate.
 */
export async function locationListIdSets({ db, filter }) {
  return idSetsFor({ filter, type: 'location_list', onEmpty: LIST_EMPTY, load: (locId) => contactIdsOnList(db, locId) })
}

/**
 * Resolve EVERY virtual field in the filter into one `{ include, exclude }`:
 *   include — Set of ids the audience is restricted to, or null (unrestricted)
 *   exclude — Set of ids removed from it (empty when include is a Set: the
 *             subtraction is done here, so only one predicate is needed)
 * Clauses combine exactly as the old per-field injection did: every positive
 * clause intersects (AND), every negative clause subtracts.
 */
export async function resolveVirtualIdSets({ db, filter, locationId }) {
  if (virtualClauses(filter).length === 0) return { include: null, exclude: new Set(), present: false }
  let include = null
  const exclude = new Set()
  for (const sets of [
    await tagIdSets({ db, filter, locationId }),
    await eventIdSets({ db, filter }),
    await locationListIdSets({ db, filter }),
  ]) {
    if (sets.include !== null) include = intersect(include, sets.include)
    for (const id of sets.exclude) exclude.add(id)
  }
  if (include !== null) {
    for (const id of exclude) include.delete(id)
    exclude.clear()
  }
  return { include, exclude, present: true }
}

/**
 * The base query for `relation` at `locationId`, already scoped server-side
 * to `include` / `exclude` (mig 795, AUDIENCEIDS.1). An rpc POST, so the id
 * lists travel in the body; PostgREST applies the caller's filters, select,
 * order and range to the function's rows as it does to the relation.
 *
 * A COUNT (`selectOpts.head`) cannot ride a HEAD request here: postgrest-js
 * puts rpc args on the URL for HEAD/GET, which is the exact failure this
 * path exists to avoid. It is translated to POST + `Prefer: count=<n>` and a
 * one-row limit, so `const { count } = await query` reads the same as before
 * (`data` is one row instead of null; no count caller reads data).
 */
export function scopedAudienceSource(db, relation, { locationId, include, exclude, columns = '*', selectOpts } = {}) {
  if (!locationId) {
    throw new InvalidAudienceFilterError('a server-side scoped audience source needs a studio (locationId)')
  }
  const args = {
    p_location_id: locationId,
    p_include: include ? Array.from(include) : null,
    p_exclude: exclude && exclude.size > 0 ? Array.from(exclude) : null,
  }
  const count = selectOpts?.count
  let q
  // Literal function names on purpose: check:rpc-names resolves each one
  // against the migrations and refuses a name held in a variable.
  if (relation === 'contact_location_audience') {
    q = db.rpc('contact_location_audience_scoped', args, count ? { count } : undefined)
  } else if (relation === 'studio_contacts') {
    q = db.rpc('studio_contacts_scoped', args, count ? { count } : undefined)
  } else {
    throw new InvalidAudienceFilterError(`no server-side scoped source for ${relation}`)
  }
  q = q.select(columns)
  if (selectOpts?.head) q = q.limit(1)
  return q
}

/**
 * Put `{ include, exclude }` on `query` within the URL budget, or rebuild the
 * query through `rebase` when they do not fit. Returns the query to continue
 * chaining on. Exported for the per-field wrappers below and for tests.
 */
export function applyIdSets(query, { include, exclude }, { rebase } = {}) {
  if (include !== null && include !== undefined) {
    // A known inclusion has its exclusions subtracted here, so one predicate
    // (never IN + NOT IN) reaches the database, whichever path it takes.
    if (exclude && exclude.size > 0) {
      include = new Set([...include].filter(id => !exclude.has(id)))
    }
    if (include.size === 0) return query.eq('id', NOBODY_ID)
    const length = idPredicateUrlLength(include)
    if (length <= AUDIENCE_ID_URL_BUDGET) return query.in('id', Array.from(include))
    if (rebase) return rebase({ include, exclude: new Set() })
    throw new InvalidAudienceFilterError(
      `This audience matches too many contacts (${include.size}) to filter on in one request: the id list alone is ${length} URL characters against a ${AUDIENCE_ID_URL_BUDGET}-character budget, and this path has no server-side scoped source. Add another filter (a stage, a date) to narrow the audience first.`
    )
  }
  if (exclude && exclude.size > 0) {
    const length = idPredicateUrlLength(exclude, { negate: true })
    if (length <= AUDIENCE_ID_URL_BUDGET) return query.not('id', 'in', `(${Array.from(exclude).join(',')})`)
    if (rebase) return rebase({ include: null, exclude })
    throw new InvalidAudienceFilterError(
      `This exclusion matches too many contacts (${exclude.size}) to apply in one request: the id list alone is ${length} URL characters against a ${AUDIENCE_ID_URL_BUDGET}-character budget, and this path has no server-side scoped source. Add a positive filter to narrow the audience first.`
    )
  }
  return query
}

/**
 * Resolve any `tag` filters in the audience filter into a contacts.id
 * constraint (Phase 3 — mig 085 retargeting).
 *
 * IMPORTANT — return shape is { query } (wrapped), NOT a bare query.
 * Supabase JS v2 query builders are THENABLE: they have a .then() that
 * triggers the actual HTTP request. JavaScript's `await` follows the
 * thenable protocol, so if an async function returns a bare builder,
 * `await asyncFn()` will FIRE the network call and resolve to
 * { data, error } instead of the builder. Downstream `query.eq(...)`
 * then throws "TypeError: e.eq is not a function" because the response
 * object has no filter methods. Wrapping in a plain object defeats the
 * auto-unwrap.
 *
 * Per-field wrapper over tagIdSets + applyIdSets. applyAudienceFilterAsync
 * (below) is the path every caller uses: it merges the three fields into one
 * predicate and can rebase. Kept for callers and tests that resolve one
 * field; over the URL budget it throws (it has no rebase).
 *
 * @returns {Promise<{ query: object }>}  wrapped to avoid thenable unwrap
 */
export async function resolveTagFilters({ db, query, filter, locationId, rebase }) {
  if (virtualClauses(filter).every(f => AUDIENCE_FIELDS[f.field].type !== 'tag')) return { query }
  return { query: applyIdSets(query, await tagIdSets({ db, filter, locationId }), { rebase }) }
}

/**
 * Resolve any `event_registration` filters into a contacts.id constraint.
 * Same wrapped { query } return as resolveTagFilters. The chosen event id is
 * itself location-bound and the base contacts query is location-scoped, so
 * no extra location filter is needed here.
 */
export async function resolveEventFilters({ db, query, filter, rebase }) {
  if (virtualClauses(filter).every(f => AUDIENCE_FIELDS[f.field].type !== 'event')) return { query }
  return { query: applyIdSets(query, await eventIdSets({ db, filter }), { rebase }) }
}

/**
 * LISTFILTER.1 — resolve `location_list` rows into a contacts.id constraint.
 * Same wrapped { query } return as resolveTagFilters.
 */
export async function resolveLocationListFilters({ db, query, filter, rebase }) {
  if (virtualClauses(filter).every(f => AUDIENCE_FIELDS[f.field].type !== 'location_list')) return { query }
  return { query: applyIdSets(query, await locationListIdSets({ db, filter }), { rebase }) }
}

/**
 * COMMSFIX.B.7 — validate an audience filter WITHOUT building a query or
 * touching the DB. For routes that PERSIST a filter (email-draft, SMS/WA
 * broadcast create, sequences PUT): an invalid filter must be rejected with
 * a 400 at save time, not parked in the DB where it can never populate (the
 * campaign wedges 'queued' forever; the sequence silently enrols nobody).
 *
 * Reuses applyAudienceFilter's full validation (unknown field, off-allowlist
 * op, OR+virtual-field rejection, numeric/boolean value guards) against a
 * passive probe that absorbs every query method, then adds the non-empty
 * value checks the tag/event resolvers would make at resolve time.
 *
 * Throws InvalidAudienceFilterError; returns undefined on a valid filter.
 * null / undefined / empty filters are valid ("everyone").
 */
export function validateAudienceFilter(filter) {
  if (filter == null) return
  let probe
  const handler = { get: () => (..._args) => probe }
  probe = new Proxy({}, handler)
  applyAudienceFilter(probe, filter)
  for (const f of filter?.filters || []) {
    const cfg = AUDIENCE_FIELDS[f?.field]
    if (!cfg) continue // applyAudienceFilter already threw on unknown fields
    if (cfg.type === 'tag' && (typeof f.value !== 'string' || !f.value.trim())) {
      throw new InvalidAudienceFilterError(TAG_EMPTY)
    }
    if (cfg.type === 'event' && (typeof f.value !== 'string' || !f.value.trim())) {
      throw new InvalidAudienceFilterError(EVENT_EMPTY)
    }
    if (cfg.type === 'location_list' && (typeof f.value !== 'string' || !f.value.trim())) {
      throw new InvalidAudienceFilterError(LIST_EMPTY)
    }
  }
}

/**
 * Resolve tag + event + location_list virtual fields AND apply scalar filters
 * in one call. Use this in async contexts (most route handlers already are).
 * Existing sync callers continue using applyAudienceFilter directly until
 * they need virtual-field support.
 *
 * Returns { query } — see resolveTagFilters above for the thenable-unwrap
 * reason. Callers must destructure:
 *   const { query: filtered } = await applyAudienceFilterAsync(...)
 *
 * @param {object} args
 * @param {SupabaseClient} args.db
 * @param {object} args.query        base query, already scoped to the studio
 * @param {object|null} args.filter
 * @param {string|null} args.locationId  the studio: scopes the tag lookup and
 *                                       the scoped source
 * @param {(sets: { include: Set|null, exclude: Set }) => object} [args.rebase]
 *   Rebuilds the SAME base query on the relation's scoped rpc twin
 *   (scopedAudienceSource) when the resolved id list does not fit the URL
 *   budget. Without it, an over-budget list throws InvalidAudienceFilterError.
 * @param {string} [args.pinnedId]   when the base query is already pinned to
 *   ONE contact (`.eq('id', contactId)` — the sequence evaluator), membership
 *   is decided here in JS and no id predicate is emitted at all: the
 *   per-contact check never carries a cohort of ids to the database.
 * @returns {Promise<{ query: object }>}
 */
export async function applyAudienceFilterAsync({ db, query, filter, locationId, rebase, pinnedId }) {
  const sets = await resolveVirtualIdSets({ db, filter, locationId })
  if (sets.present) {
    if (pinnedId) {
      const out = (sets.include !== null && !sets.include.has(pinnedId)) || sets.exclude.has(pinnedId)
      if (out) query = query.eq('id', NOBODY_ID)
    } else {
      query = applyIdSets(query, sets, { rebase })
    }
  }
  return { query: applyAudienceFilter(query, filter) }
}

/**
 * One line a populate or count path can log when an audience query resolves
 * to `{ error }`: the message (or a stated empty one), with the status, the
 * PostgREST code and the request URL length a bare `error.message` hides. The
 * 31 Oct 2026 failure left "audience load failed: " in campaigns.last_error
 * and nothing else to go on.
 *
 * @param {string} prefix          e.g. 'audience load failed'
 * @param {object} res             { error, status, statusText } as resolved by supabase-js
 * @param {object} [query]         the builder that was awaited (its URL length is read)
 */
export function describeAudienceQueryError(prefix, { error, status, statusText } = {}, query) {
  const message = typeof error?.message === 'string' && error.message.trim() ? error.message : '(empty message)'
  const parts = []
  if (status !== undefined && status !== null) parts.push(`status=${status}${statusText ? ` ${statusText}` : ''}`)
  if (error?.code) parts.push(`code=${error.code}`)
  if (error?.details) parts.push(`details=${String(error.details).slice(0, 200)}`)
  if (error?.hint) parts.push(`hint=${String(error.hint).slice(0, 200)}`)
  const url = query?.url
  const urlLength = typeof url === 'string' ? url.length : (url && typeof url.toString === 'function' ? url.toString().length : null)
  if (urlLength) parts.push(`url_length=${urlLength}`)
  if (query?.method) parts.push(`method=${query.method}`)
  return `${prefix}: ${message}${parts.length ? ` [${parts.join(', ')}]` : ''}`
}
