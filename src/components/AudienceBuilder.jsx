'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Plus, Trash2, Users, AlertTriangle, Sparkles } from 'lucide-react'
// FILTER-A.1 — the verified preset definitions live in their own module so the
// counts they produce can be checked against the spec table without rendering.
import { presetFilter } from '@/lib/audience-presets'
// COMMSFIX.B.3 — the server-side allowlist is the single source of truth for
// which ops a field supports. The per-type op lists below are filtered
// against it so the UI can never build a row the count/populate side 400s on
// (e.g. is_null on email_status, which is eq/neq-only server-side).
import { AUDIENCE_FIELDS } from '@/lib/audience-filter'
// FILTER-P1.4 — a seeded date must be the operator's business today, not a
// UTC one; `new Date().toISOString().split('T')[0]` is lint-banned for this.
import { dublinTodayStr } from '@/lib/dublin-time'

// FILTER-A.2 — the groups an operator thinks in, in the order they think of
// them. Rendered as <optgroup>s; every FIELD_OPTIONS entry must name one (the
// fields test enforces it), so a new field cannot land ungrouped at the bottom
// of a wall of 39 options the way the old DB-column ordering let it.
export const FIELD_GROUPS = Object.freeze([
  'Funnel',
  'Membership & billing',
  'Attendance',
  'Money',
  'Email behaviour',
  'Tags & labels',
  'Events',
  // LISTFILTER.1 — its own group rather than folded into Tags & labels: a
  // studio-list row is membership of another location's comms list, not a
  // label someone applied, and burying it would leave the only answer to
  // "who is on the Hatch list" undiscoverable.
  'Studios',
  'Dates & tenure',
  'Profile & data quality',
])

// FILTER-A.2 — funnel slugs are stored raw and used to be rendered by
// `replace(/_/g,' ')`, which produced "classpass" and "pack member". Display
// names are explicit so ClassPass keeps its capitals and a retired slug that
// is NOT in this map is detectable (see the saved-value warning below —
// three live campaigns still carry `active_member`).
const STAGE_LABELS = Object.freeze({
  new_lead: 'New lead',
  first_class: 'First class',
  second_class: 'Second class',
  trial_done: 'Trial done',
  converted: 'Converted',
  member: 'Member',
  pack_member: 'Pack member',
  classpass: 'ClassPass',
  cold_lead: 'Cold lead',
  dormant: 'Dormant',
})

export const FIELD_OPTIONS = [
  // ── Funnel ──────────────────────────────────────────────────────
  // FUNNEL.1 — primary funnel-stage filter (canonical funnel slugs,
  // mig 350). Denormalised onto contacts.pipeline_stage_slug (originally
  // mig 155, synced from deals.stage_id via trigger). Stage placement is
  // classifier-derived (webhook + nightly cron) — operators never write
  // it. It replaced the legacy "Lead Status" filter that was effectively
  // dead (>99% defaulted on import and was never reliably updated).
  { value: 'pipeline_stage_slug',   label: 'Stage',                 type: 'select',
    group: 'Funnel',
    hint: 'Where our funnel classifier places them. This is the one to use — Membership Status below is the raw vendor field it reads.',
    options: ['new_lead', 'first_class', 'second_class', 'trial_done',
              'converted', 'member', 'pack_member', 'classpass', 'cold_lead', 'dormant'],
    valueLabels: STAGE_LABELS },
  { value: 'lead_source',           label: 'Lead Source',           type: 'select',
    group: 'Funnel',
    options: ['booking', 'meta', 'tiktok', 'walkin', 'referral', 'website', 'whatsapp', 'classpass', 'other'],
    valueLabels: { walkin: 'Walk-in', classpass: 'ClassPass', whatsapp: 'WhatsApp', tiktok: 'TikTok', meta: 'Meta' } },
  { value: 'glofox_source',         label: 'Signup Source',         type: 'text',
    group: 'Funnel',
    hint: 'How the booking system recorded the signup. Lead Source above is ours and is the one campaigns normally use.' },
  // GLOFOX2.1.8 — Glofox-side raw membership status. This is what the
  // pipeline classifier reads — most operators should filter on
  // "Stage" above instead. Kept as an advanced filter for power users
  // (credit_member upsells, classpass_payg cohorts).
  { value: 'glofox_membership_status', label: 'Membership Status (advanced)', type: 'select',
    group: 'Membership & billing',
    hint: 'Raw status from the booking system — the input our Stage classifier reads. Prefer Stage unless you specifically need a raw value.',
    options: ['cold', 'tour', 'no_sale_tour', 'trial', 'no_sale_trial',
              'member', 'credit_member', 'classpass_payg', 'ex_member', 'lead'],
    valueLabels: { no_sale_tour: 'Tour, no sale', no_sale_trial: 'Trial, no sale',
                   credit_member: 'Credit member', classpass_payg: 'ClassPass / PAYG', ex_member: 'Ex-member' } },
  // CHURN-PREP.2 — current Glofox membership plan. The plan list is
  // operator-defined (not a fixed enum), so the value dropdown is
  // loaded dynamically from /api/contacts/membership-plans at mount.
  { value: 'glofox_membership_plan', label: 'Membership Plan',      type: 'plan-select',
    group: 'Membership & billing',
    hint: 'The named plan they are on ("3 Month Membership"). Membership Type below is the shape of it (recurring / pack / pay-as-you-go).' },
  // GLOFOX-PROFILE (mig 196) — wider Glofox membership profile,
  // synced nightly. Lets campaigns target billing structure and
  // member attributes alongside plan / status.
  //
  // FILTER-A.2 — `time` reads as a date field and means monthly recurring.
  // That mistranslation is exactly what the 8-Aug sale email turned on, so
  // the raw values are never shown to an operator again.
  { value: 'glofox_membership_type', label: 'Membership Type',      type: 'select',
    group: 'Membership & billing',
    hint: 'The billing shape. "Monthly recurring" is the group a sale email normally excludes.',
    options: ['time', 'num_classes', 'payg'],
    valueLabels: { time: 'Monthly recurring', num_classes: 'Class pack', payg: 'Pay as you go' } },
  // 'locked' = a membership in payment arrears (the radar's Overdue
  // tab). Pick it to build an overdue segment for a dunning sequence.
  { value: 'glofox_membership_state', label: 'Membership State',    type: 'select',
    group: 'Membership & billing',
    hint: '"Locked" means the membership is in payment arrears — that is the overdue / dunning audience.',
    options: ['active', 'paused', 'locked'],
    valueLabels: { active: 'Active', paused: 'Paused', locked: 'Locked (in arrears)' } },
  { value: 'glofox_membership_expiry', label: 'Membership Renews/Expires', type: 'date',
    group: 'Membership & billing' },
  { value: 'glofox_billing_interval', label: 'Billing Interval',    type: 'text',
    group: 'Membership & billing' },
  { value: 'glofox_payment_method',  label: 'Payment Method',       type: 'text',
    group: 'Membership & billing' },
  { value: 'glofox_roaming_enabled', label: 'Roaming Enabled',      type: 'boolean',
    group: 'Membership & billing' },
  { value: 'glofox_account_active',  label: 'Booking Account Active', type: 'boolean',
    group: 'Membership & billing' },
  // ── Attendance ──────────────────────────────────────────────────
  // GLOFOX2.1.14 — booking-engagement aggregates from Glofox sync.
  // Powers re-engagement audiences ("haven't attended in 14 days"),
  // welcome sequences ("first attendance"), and high-engagement
  // segmentation ("attended >8 classes this month").
  { value: 'last_attended_at',      label: 'Last Attended',          type: 'date',
    group: 'Attendance',
    hint: 'Last class they actually turned up to. A no-show moves Last Booked but not this.' },
  { value: 'last_booked_at',        label: 'Last Booked',            type: 'date',
    group: 'Attendance',
    hint: 'Last class they booked, whether or not they showed up. A no-show updates this and not Last Attended.' },
  { value: 'total_attended_30d',    label: 'Attended (30d)',         type: 'number', group: 'Attendance' },
  { value: 'total_bookings_30d',    label: 'Bookings (30d)',         type: 'number', group: 'Attendance' },
  { value: 'total_noshow_30d',      label: 'No-shows (30d)',         type: 'number', group: 'Attendance' },
  { value: 'trial_credits_remaining', label: 'Trial Credits Left',   type: 'number', group: 'Attendance' },
  // ── Money ───────────────────────────────────────────────────────
  // GLOFOX2.1.20 — Lifetime Value from invoice webhook. Powers VIP
  // segmentation, at-risk audiences, and revenue-cohort analysis.
  //
  // FILTER-A.2 — stored in cents for precision; the operator types EUROS
  // and the builder converts. "Lifetime Value (cents) > 50000" asked an
  // operator to do arithmetic to express €500, and getting it wrong is
  // silent — the filter still resolves, just against the wrong cohort.
  { value: 'lifetime_value_cents',       label: 'Lifetime Value (€)',    type: 'money', group: 'Money' },
  { value: 'glofox_membership_price_cents', label: 'Membership Price (€)', type: 'money', group: 'Money' },
  { value: 'lifetime_transaction_count', label: 'Lifetime Payments',     type: 'number', group: 'Money' },
  { value: 'last_payment_at',            label: 'Last Payment',          type: 'date',
    group: 'Money',
    hint: 'Last payment that actually succeeded. Last Invoice below counts attempts too.' },
  { value: 'last_invoice_at',            label: 'Last Invoice (any status)', type: 'date',
    group: 'Money',
    hint: 'Any invoice, paid or not — and the invoice table is stale, so treat this as a weak signal and never as "what they owe".' },
  // ── Email behaviour ─────────────────────────────────────────────
  // COMMSFIX.B.3 — 'unsubscribed' removed: mig 501 CHECK-bans the value
  // (email_status is reputation-only; consent lives per-location in
  // contact_location_preferences), so the option could never match a row.
  { value: 'email_status',          label: 'Email Status',          type: 'select',
    group: 'Email behaviour',
    hint: 'Deliverability only (bounces, complaints). Marketing consent is applied automatically by the send and is not a filter.',
    options: ['active', 'bounced', 'complained'] },
  { value: 'total_emails_sent',     label: 'Emails Sent',           type: 'number', group: 'Email behaviour' },
  { value: 'total_emails_opened',   label: 'Emails Opened',         type: 'number', group: 'Email behaviour' },
  // GAPS-P1.3 — server-allowlisted since mig 005 and backfilled by mig 508,
  // but never offered here while its sibling above was. An operator could
  // build "opened > 0" and not "clicked > 0".
  { value: 'total_emails_clicked',  label: 'Emails Clicked',        type: 'number', group: 'Email behaviour' },
  { value: 'last_emailed_at',       label: 'Last Emailed',          type: 'date',
    group: 'Email behaviour',
    hint: 'When WE last emailed them. The two below are whether THEY engaged.' },
  // GAPS-P1.3 — engagement RECENCY (mig 511). "Last Emailed" says whether WE
  // emailed them; these say whether they engaged. Pair either with the date
  // type's days_since ops for "opened in the last 30 days".
  { value: 'last_email_open_at',    label: 'Last Email Open',       type: 'date', group: 'Email behaviour' },
  { value: 'last_email_click_at',   label: 'Last Email Click',      type: 'date', group: 'Email behaviour' },
  // ── Tags & labels ───────────────────────────────────────────────
  // FILTER-P1.3 — contacts.tags is TEXT[], not text. Its own builder type so
  // it stops borrowing the scalar text op list, which offered "contains" (an
  // exact element match here, so typing PT never found PTC — the same
  // operation as "equals" under a second name) and is-empty/is-not-empty
  // NULL tests that were meaningless against a DEFAULT '{}' column.
  //
  // FILTER-A.3 — "Free-text tag" vs "Segment tag" told an operator nothing
  // about which of the two they wanted. They CANNOT honestly be collapsed
  // into one field: they are different columns with different writers
  // (contacts.tags TEXT[] vs the contact_tags table), and a single field that
  // matched either would need applyAudienceFilter to OR across both storages
  // — a query-layer change this work is explicitly not making. So the split
  // stays, named by the only thing an operator actually needs to decide
  // between them: HOW the tag got there. Adjacent in the same group so the
  // choice is presented rather than stumbled into.
  { value: 'tags',                  label: 'Manual tag',            type: 'tag-array', group: 'Tags & labels',
    hint: 'Typed onto the contact by staff, or set during an import. Free text — spell it exactly as it was entered.' },
  // Phase 3 (mig 085): machine-derived retargeting tags. Resolved
  // server-side via contact_tags. The select options are loaded
  // dynamically from /api/segments at mount time.
  { value: 'tag',                   label: 'Behaviour tag',         type: 'tag-select', group: 'Tags & labels',
    hint: 'Applied automatically by the platform and by sequences (first booking, trial running low, race finished). Pick from the list.' },
  { value: 'label',                 label: 'Label',                 type: 'text', group: 'Tags & labels' },
  // ── Events ──────────────────────────────────────────────────────
  // EVENT-FILTER — virtual field. Resolved server-side via
  // resolveEventFilters (race_registrations → contacts.id). Options load
  // dynamically from /api/communications/events. Value is a race_events id.
  { value: 'event_registration',    label: 'Registered for event',  type: 'event-select', group: 'Events' },
  // LISTFILTER.1 — virtual field. Resolved server-side via
  // resolveLocationListFilters (contact_location_preferences → contacts.id).
  // Options load from /api/locations. Value is a locations id.
  { value: 'location_list',         label: "On another studio's list", type: 'location-select', group: 'Studios',
    hint: 'Who holds a comms record at that studio — a waitlist or registered-interest roll-call, not a send estimate. Consent is applied separately by the send itself.' },
  // ── Dates & tenure ──────────────────────────────────────────────
  { value: 'created_at',            label: 'Contact Created',       type: 'date',
    group: 'Dates & tenure',
    hint: 'When the contact row appeared in the CRM — an import date as often as a real first-touch date.' },
  { value: 'lead_created_at',       label: 'Lead Created',          type: 'date',
    group: 'Dates & tenure',
    hint: 'Known unreliable — lead_created_at was poisoned by a historical backfill. Do not trust it for cohort dates; use Joined or Contact Created.' },
  // GLOFOX2.1.13 — Glofox-side tenure date (joined_at preferred,
  // falls back to created). Powers "Members > 6 months" anniversary
  // campaigns + cohort analysis.
  { value: 'joined_at',             label: 'Joined',                type: 'date',
    group: 'Dates & tenure',
    hint: 'Membership start date — the trustworthy one for tenure and anniversary campaigns.' },
  // ── Profile & data quality ──────────────────────────────────────
  { value: 'gender',                 label: 'Gender',               type: 'select',
    group: 'Profile & data quality',
    options: ['male', 'female', 'other'],
    valueLabels: { male: 'Male', female: 'Female', other: 'Other' } },
  { value: 'emergency_contact',      label: 'Has Emergency Contact', type: 'exists', group: 'Profile & data quality' },
  { value: 'glofox_member_id',      label: 'Linked to Booking System', type: 'exists', group: 'Profile & data quality' },
  { value: 'gympass_member_id',     label: 'Gympass Member',        type: 'exists', group: 'Profile & data quality' },
  { value: 'phone',                 label: 'Has Phone',             type: 'exists', group: 'Profile & data quality' },
]

const OPS_BY_TYPE = {
  // COMMSFIX.B.3 — is empty / is not empty added to select, text and number
  // types (the library has supported is_null/not_null on most of these
  // fields all along; the UI hid them, which is what made the NULL-dropping
  // "is not X" incident unbuildable-around). opsForField() intersects each
  // list with the server allowlist, so fields like email_status that are
  // eq/neq-only server-side never show the null ops.
  select:  [
    { value: 'eq',  label: 'is' },
    { value: 'neq', label: 'is not' },
    { value: 'is_null',  label: 'is empty' },
    { value: 'not_null', label: 'is not empty' },
  ],
  // tag-select uses the same eq/neq semantics as select but pulls
  // its options dynamically from /api/segments.
  'tag-select': [
    { value: 'eq',  label: 'has tag' },
    { value: 'neq', label: 'does not have tag' },
  ],
  // event-select — registered / not registered for a specific event.
  'event-select': [
    { value: 'eq',  label: 'registered for' },
    { value: 'neq', label: 'not registered for' },
  ],
  // location-select — on / not on a given studio's list.
  'location-select': [
    { value: 'eq',  label: 'on the list for' },
    { value: 'neq', label: 'not on the list for' },
  ],
  // plan-select — dynamic membership-plan dropdown. is_null / not_null
  // need no value (the value selector hides via needsValue()).
  'plan-select': [
    { value: 'eq',       label: 'is' },
    { value: 'neq',      label: 'is not' },
    { value: 'not_null', label: 'has any plan' },
    { value: 'is_null',  label: 'has no plan' },
  ],
  // FILTER-P1.3 — the array tag field. Four ops, each one distinct:
  // membership (cs) in both directions, and REAL emptiness (contained-by
  // '{}') rather than a NULL test the column's '{}' default made useless.
  'tag-array': [
    { value: 'eq',       label: 'has tag' },
    { value: 'neq',      label: 'does not have tag' },
    { value: 'not_null', label: 'has any tag' },
    { value: 'is_null',  label: 'has no tags' },
  ],
  text:    [
    { value: 'eq',           label: 'equals' },
    { value: 'neq',          label: 'does not equal' },
    { value: 'contains',     label: 'contains' },
    { value: 'not_contains', label: 'does not contain' },
    { value: 'is_null',      label: 'is empty' },
    { value: 'not_null',     label: 'is not empty' },
  ],
  number:  [
    { value: 'eq',  label: 'equals' },
    { value: 'neq', label: 'is not' },
    { value: 'gt',  label: 'greater than' },
    { value: 'lt',  label: 'less than' },
    { value: 'gte', label: 'at least' },
    { value: 'lte', label: 'at most' },
    { value: 'is_null',  label: 'is empty' },
    { value: 'not_null', label: 'is not empty' },
  ],
  // FILTER-A.2 — money is number semantics with a euro↔cent display shim.
  // The stored value stays cents, so nothing downstream changes.
  money:   [
    { value: 'eq',  label: 'equals' },
    { value: 'neq', label: 'is not' },
    { value: 'gt',  label: 'greater than' },
    { value: 'lt',  label: 'less than' },
    { value: 'gte', label: 'at least' },
    { value: 'lte', label: 'at most' },
    { value: 'is_null',  label: 'is empty' },
    { value: 'not_null', label: 'is not empty' },
  ],
  date:    [
    { value: 'gt',       label: 'after' },
    { value: 'lt',       label: 'before' },
    { value: 'is_null',  label: 'has no value' },
    { value: 'not_null', label: 'has a value' },
    { value: 'days_since_gt', label: 'more than X days ago' },
    { value: 'days_since_lt', label: 'less than X days ago' },
  ],
  exists:  [
    { value: 'not_null', label: 'exists' },
    { value: 'is_null',  label: 'does not exist' },
  ],
  // boolean — Glofox true/false flags. eq carries a Yes/No value;
  // is_null / not_null need none (handled by needsValue()).
  boolean: [
    { value: 'eq',       label: 'is' },
    { value: 'not_null', label: 'has a value' },
    { value: 'is_null',  label: 'has no value' },
  ],
}

// COMMSFIX.B.3 — returns null for a field not in FIELD_OPTIONS. The old
// FIELD_OPTIONS[0] fallback made a saved legacy filter (e.g. pre-FUNNEL.1
// lead_status) silently masquerade as a 'Stage' row: the display bore no
// relation to what was saved, and touching the op wrote Stage-ops onto the
// foreign field. Unknown fields now render an inert warning row instead.
function getFieldConfig(fieldValue) {
  return FIELD_OPTIONS.find(f => f.value === fieldValue) || null
}

// The ops offered for a row = the per-type list ∩ the server allowlist for
// that specific field. Keeps the UI unable to build a row the count/populate
// side rejects (the composer used to swallow that 400 silently).
function opsForField(fieldConfig) {
  const base = OPS_BY_TYPE[fieldConfig.type] || []
  const allowed = AUDIENCE_FIELDS[fieldConfig.value]?.ops
  return allowed ? base.filter(op => allowed.includes(op.value)) : base
}

function needsValue(op) {
  return !['is_null', 'not_null'].includes(op)
}

// FILTER-A.3 — the three value pickers whose options are fetched, extracted so
// a PENDING row (field chosen, value not yet) and a committed row render the
// identical control. Without the extraction the pending row would need its own
// copy and the two would drift.
function DynamicValueSelect({ type, value, disabled, onChange, tagOptions, planOptions, eventOptions, locationOptions, className }) {
  const cls = className || 'bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text focus-visible:border-un1t-text flex-1'
  if (type === 'tag-select') {
    return (
      <select value={value || ''} disabled={disabled} onChange={onChange} aria-label="Tag" className={cls}>
        <option value="">{tagOptions === null ? 'Loading tags…' : '— pick a tag —'}</option>
        {(tagOptions || []).map(opt => (
          // FILTER-A.3 — the count says how much reach the tag has; the
          // description is what /api/segments has always returned and the
          // builder used to throw away.
          <option key={opt.tag} value={opt.tag} title={opt.description || undefined}>
            {opt.tag} ({opt.count})
          </option>
        ))}
      </select>
    )
  }
  if (type === 'plan-select') {
    return (
      <select value={value || ''} disabled={disabled} onChange={onChange} aria-label="Membership plan" className={cls}>
        <option value="">{planOptions === null ? 'Loading plans…' : '— pick a plan —'}</option>
        {(planOptions || []).map(plan => <option key={plan} value={plan}>{plan}</option>)}
      </select>
    )
  }
  // LISTFILTER.1 — explicit, and placed BEFORE the events control on purpose:
  // that one used to be the bare fallthrough, so any dynamic type added after
  // it would have quietly rendered an events dropdown labelled "Event".
  if (type === 'location-select') {
    return (
      <select value={value || ''} disabled={disabled} onChange={onChange} aria-label="Studio" className={cls}>
        <option value="">{locationOptions === null ? 'Loading studios…' : '— pick a studio —'}</option>
        {(locationOptions || []).map(loc => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
      </select>
    )
  }
  return (
    <select value={value || ''} disabled={disabled} onChange={onChange} aria-label="Event" className={cls}>
      <option value="">{eventOptions === null ? 'Loading events…' : '— pick an event —'}</option>
      {(eventOptions || []).map(ev => (
        <option key={ev.id} value={ev.id}>
          {ev.name} — {ev.kind} — {ev.race_date}
          {typeof ev.registration_count === 'number' ? ` (${ev.registration_count})` : ''}
        </option>
      ))}
    </select>
  )
}

// FILTER-A.4 — the connector column. It is DECORATIVE for assistive tech: the
// row group's accessible name already says "AND — Filter 2 of 3", so repeating
// the word here would double-announce. It stays visible, and now carries the
// row NUMBER, which is what makes a 30-row list navigable at all.
function RowConnector({ index, logic }) {
  return (
    <span data-testid="row-connector" aria-hidden="true" className="w-10 shrink-0 text-center leading-tight">
      <span className="block text-[10px] text-un1t-muted tabular-nums">{index + 1}</span>
      {index > 0 && <span className="block text-xs text-un1t-muted font-medium uppercase">{logic}</span>}
    </span>
  )
}

// FILTER-C.2 — does this field match what the operator typed? Label first
// (what they see) and group second, so "money" reaches the Money fields whose
// own labels never say the word. Deliberately NOT the hint text: a hint is a
// paragraph, and matching on it makes the result set look arbitrary.
function fieldMatchesSearch(opt, term) {
  if (!term) return true
  return opt.label.toLowerCase().includes(term) || opt.group.toLowerCase().includes(term)
}

// FILTER-A.2 / FILTER-C.2 — the grouped, searchable field picker.
//
// The CONTROL is still a native <select> with <optgroup>, deliberately: it
// supplies keyboard navigation, type-ahead, the mobile picker and correct
// screen-reader semantics (including group announcement) for free, and a
// hand-rolled combobox that re-earns all of that imperfectly is a worse
// outcome than the list it replaces. FILTER-A.2 added the grouping, which
// fixed the first-letter type-ahead collisions ("Membership …" ×4, "Last …"
// ×5), and recorded the gap it did not close: with 40+ fields an operator who
// does not already know a field's exact LABEL — or which of nine groups it
// lives in — can only open the list and scan.
//
// FILTER-C.2 closes it with a plain text input in FRONT of the select that
// narrows which options the select renders. Nothing about the select's
// semantics changes; the groups are re-derived from the surviving options, so
// grouping cannot regress, and an empty group simply stops rendering. Two
// details are load-bearing:
//
//  - The row's OWN saved field is always rendered, even when it does not
//    match. A <select> whose value matches no <option> renders BLANK, which
//    reads as an unset row while still filtering — the exact failure
//    FILTER-A.2 hit with the retired `active_member` stage value.
//  - Enter is swallowed. These pickers sit inside host <form>s (the campaign
//    editor), where Enter in a text input submits.
function FieldSelect({ value, onChange, disabled, describedBy, className, cellClassName, inputRef }) {
  const uid = useId()
  const selectId = `${uid}-field`
  const [search, setSearch] = useState('')
  const term = search.trim().toLowerCase()

  const matchCount = term ? FIELD_OPTIONS.filter(o => fieldMatchesSearch(o, term)).length : FIELD_OPTIONS.length
  const isVisible = (opt) => fieldMatchesSearch(opt, term) || opt.value === value
  const groups = FIELD_GROUPS
    .map(group => ({ group, options: FIELD_OPTIONS.filter(o => o.group === group && isVisible(o)) }))
    .filter(g => g.options.length > 0)

  return (
    <div className={`flex flex-col gap-1 min-w-0 ${cellClassName || ''}`}>
      <input
        type="search"
        value={search}
        disabled={disabled}
        aria-label="Search fields"
        aria-controls={selectId}
        placeholder="Search fields…"
        onChange={e => setSearch(e.target.value)}
        onKeyDown={e => {
          // Enter must not submit the host form, and Escape is the expected
          // way out of a search box for a keyboard user.
          if (e.key === 'Enter') e.preventDefault()
          else if (e.key === 'Escape') setSearch('')
        }}
        className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-xs text-un1t-text placeholder:text-un1t-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text focus-visible:border-un1t-text disabled:opacity-50"
      />
      <select
        id={selectId}
        ref={inputRef}
        value={value || ''}
        disabled={disabled}
        // Picking a field ends the search — the row's picker goes back to the
        // full list rather than staying silently narrowed for the next visit.
        onChange={e => { setSearch(''); onChange(e) }}
        aria-label="Field"
        aria-describedby={describedBy || undefined}
        className={className}
      >
        {/* FILTER-P1.1 — reachable "unset" so a row can be emptied without
            deleting it (and so a saved unset row round-trips). */}
        <option value="">Choose a field…</option>
        {groups.map(({ group, options }) => (
          <optgroup key={group} label={group}>
            {options.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
      {/* Mounted unconditionally, empty when idle — FILTER-A.4's lesson was
          that a live region which only appears once it has something to say is
          not announced when that first thing arrives. role="status" carries an
          implicit aria-live="polite"; the attribute is deliberately NOT spelled
          out, so the builder's ONE explicitly-polite region stays the audience
          count at the foot of the list. */}
      <span role="status" className="text-[10px] text-un1t-muted min-h-[0.75rem]">
        {term
          ? (matchCount === 0 ? 'No fields match' : `${matchCount} field${matchCount === 1 ? '' : 's'} match`)
          : ''}
      </span>
    </div>
  )
}

// FILTER-P1.4 — a date row must be born with a value the server will accept.
// The old default ('after' + '') validated fine, persisted, and only failed at
// SEND time as a raw Postgres `invalid input syntax for type timestamp`. The
// two shapes a date row can hold are NOT interchangeable, so switching between
// them has to swap the value as well as the op: a date compare wants an ISO
// day, a days_since op wants a day COUNT.
const DAYS_SINCE_OPS = ['days_since_gt', 'days_since_lt']
const DEFAULT_DAY_COUNT = '30'

function defaultValueForDateOp(op) {
  return DAYS_SINCE_OPS.includes(op) ? DEFAULT_DAY_COUNT : dublinTodayStr()
}

// FILTER-A.2 — euro ↔ cent shim for the two money-typed fields. The STORED
// value stays cents (nothing downstream changes); only the input speaks euros.
// Rounded, not truncated, so 12.345 → 1235 rather than 1234.
export function centsToEuroText(cents) {
  if (cents === '' || cents === null || cents === undefined) return ''
  const n = Number(cents)
  return Number.isFinite(n) ? String(n / 100) : ''
}
// Monotonic source of row keys. Module-level so it survives a re-render
// without a ref (refs may not be touched during render).
let ROW_KEY_SEQ = 0
function mintRowKey() { return `fr-${ROW_KEY_SEQ++}` }

export function euroTextToCents(text) {
  if (text === '' || text === null || text === undefined) return ''
  const n = Number(text)
  return Number.isFinite(n) ? String(Math.round(n * 100)) : ''
}

// FILTER-P1.1 / FILTER-B.3 / FILTER-C.3 — the row "Add filter" used to
// hard-code for every host became opt-in via `defaultFilterRow`, and then went
// away entirely. The shared STAGE_MEMBER_DEFAULT_ROW constant that carried it
// is deleted: FILTER-B.3 removed the seed from the WhatsApp and SMS editors and
// FILTER-C.3 from its last two hosts (the unified composer and the campaign
// editor), leaving nothing to define. The argument is the same one each time —
// a guessed audience the operator never chose renders as an ordinary row,
// indistinguishable from a deliberate filter, so `Stage = member` silently
// excluded every lead from any campaign built by someone who never opened the
// builder. The `defaultFilterRow` PROP survives for a host that genuinely wants
// to seed a row; with none the row starts UNSET and inert (isUnsetFilterRow).

// FILTER-A.3 / FILTER-FOUND row 3 — field types whose value comes from a
// lookup the operator has not made yet. Committing the row on field-choice
// seeds `value: ''`, which the tag/event resolvers reject outright ("tag
// filter requires a non-empty string value") and which a plan row compiles to
// `plan = ''` — a filter that matches nobody, silently. Either way the row is
// born broken. It stays UNSET (and therefore inert) until a value is picked.
const AWAITS_A_VALUE = ['tag-select', 'event-select', 'plan-select', 'location-select']

// FILTER-B.1 / FILTER-FOUND row 2 — `audienceCount` DEFAULTS TO NULL. The
// footer below renders on a non-null count, so a host that simply OMITTED the
// prop used to get `undefined !== null` → a dangling "undefined contacts
// match". COMMSFIX.B.6 fixed each host individually and left the trap armed
// for the next embed; the default closes it at the component. Hosts wanting a
// live number now mount the shared <AudienceCount> instead of feeding this
// footer, which survives only for CampaignEditor's own count state.
export default function AudienceBuilder({ filter, onChange, audienceCount = null, disabled = false, defaultFilterRow = null, presets = null, locationId = null }) {
  const filters = filter?.filters || []
  const logic = filter?.logic || 'and'

  // FILTER-A.2/A.4 — STABLE ROW IDENTITY. Rows were keyed by array index, so
  // deleting row 2 of 5 re-keyed rows 3-5: React reused the DOM nodes for
  // different filters, focus landed on a control that now represented another
  // row, and any per-row local state (the money draft below) followed the
  // wrong row. Keys are minted once per row and spliced in lockstep with the
  // array, so a row keeps its identity for its whole life. They are UI-only
  // and never reach the saved filter JSON.
  //
  // Held in state rather than a ref because a ref may not be read or written
  // during render (react-hooks/refs). The length-mismatch branch is React's
  // sanctioned derived-state-during-render pattern: it re-renders before
  // commit, so the placeholder keys below never reach the DOM.
  const [rowKeyState, setRowKeyState] = useState(() => filters.map(() => mintRowKey()))
  if (rowKeyState.length !== filters.length) {
    setRowKeyState(filters.map((_, i) => rowKeyState[i] || mintRowKey()))
  }
  const rowKeys = rowKeyState.length === filters.length
    ? rowKeyState
    : filters.map((_, i) => rowKeyState[i] || `pending-${i}`)

  // FILTER-A.2 — money inputs are the one place the stored value and the typed
  // value differ, so the raw keystrokes need somewhere to live. Without this
  // draft the round-trip cents → euros rewrites "12." to "12" on the next
  // render and a decimal amount is literally untypeable.
  const [euroDrafts, setEuroDrafts] = useState({})

  // FILTER-FOUND row 3 — the field an operator has PICKED but not yet given a
  // value to. Held here rather than on the row so the row itself stays unset
  // (inert to validation, the count endpoint and the DB) while the operator
  // is mid-choice. Keyed by stable row key, so a delete elsewhere in the list
  // cannot transplant it onto another row.
  const [pendingFields, setPendingFields] = useState({})
  const pendingList = Object.values(pendingFields)

  // FILTER-A.4 — FOCUS MANAGEMENT. Adding a row left focus on the "Add filter"
  // button, so a keyboard user had to tab back through the whole list to reach
  // the row they had just created; deleting one dropped focus to <body>
  // entirely. The map is written from ref callbacks and read only inside the
  // effect, never during render.
  const fieldNodes = useRef(new Map())
  const addButtonRef = useRef(null)
  const [focusRowKey, setFocusRowKey] = useState(null)
  useEffect(() => {
    if (!focusRowKey) return
    const node = focusRowKey === '__add__' ? addButtonRef.current : fieldNodes.current.get(focusRowKey)
    node?.focus()
    setFocusRowKey(null)
  }, [focusRowKey])
  const registerField = (key) => (node) => {
    if (node) fieldNodes.current.set(key, node)
    else fieldNodes.current.delete(key)
  }

  // Tag options loaded once at mount from /api/segments (Phase 3,
  // mig 085). Only fetched if the user actually opens a tag-select
  // row — keeps the page free for callers that don't use tags.
  const [tagOptions, setTagOptions] = useState(null)
  const usesTagField = filters.some(f => f.field === 'tag') || pendingList.includes('tag')
  useEffect(() => {
    if (!usesTagField || tagOptions !== null) return
    let cancelled = false
    // FILTER-A.3 / finding #15 — the counts must describe the location being
    // composed for. Without this the route falls back to the operator's ACTIVE
    // location, so a send built for one gym showed another gym's tag counts.
    const url = locationId ? `/api/segments?location_id=${encodeURIComponent(locationId)}` : '/api/segments'
    fetch(url).then(r => r.json()).then(j => {
      if (!cancelled && j?.success) setTagOptions(j.data || [])
      else if (!cancelled) setTagOptions([])
    }).catch(() => { if (!cancelled) setTagOptions([]) })
    return () => { cancelled = true }
  }, [usesTagField, tagOptions, locationId])

  // CHURN-PREP.2 — membership-plan options, loaded once the user
  // adds a "Membership Plan" row. The plan list is operator-defined,
  // so it's fetched live rather than hardcoded as an enum.
  const [planOptions, setPlanOptions] = useState(null)
  const usesPlanField = filters.some(f => f.field === 'glofox_membership_plan') || pendingList.includes('glofox_membership_plan')
  useEffect(() => {
    if (!usesPlanField || planOptions !== null) return
    let cancelled = false
    fetch('/api/contacts/membership-plans').then(r => r.json()).then(j => {
      if (!cancelled && j?.success) setPlanOptions(j.data || [])
      else if (!cancelled) setPlanOptions([])
    }).catch(() => { if (!cancelled) setPlanOptions([]) })
    return () => { cancelled = true }
  }, [usesPlanField, planOptions])

  // EVENT-FILTER — event options, loaded once the user adds a
  // "Registered for event" row. Mirrors the tag/plan dynamic loaders.
  const [eventOptions, setEventOptions] = useState(null)
  const usesEventField = filters.some(f => f.field === 'event_registration') || pendingList.includes('event_registration')
  useEffect(() => {
    if (!usesEventField || eventOptions !== null) return
    let cancelled = false
    fetch('/api/communications/events').then(r => r.json()).then(j => {
      if (!cancelled && j?.success) setEventOptions(j.data || [])
      else if (!cancelled) setEventOptions([])
    }).catch(() => { if (!cancelled) setEventOptions([]) })
    return () => { cancelled = true }
  }, [usesEventField, eventOptions])

  // LISTFILTER.1 — studio options, loaded once the operator adds an
  // "On another studio's list" row. Mirrors the tag/plan/event loaders.
  const [locationOptions, setLocationOptions] = useState(null)
  const usesLocationField = filters.some(f => f.field === 'location_list') || pendingList.includes('location_list')
  useEffect(() => {
    if (!usesLocationField || locationOptions !== null) return
    let cancelled = false
    fetch('/api/locations').then(r => r.json()).then(j => {
      if (!cancelled && j?.success) setLocationOptions(j.data || [])
      else if (!cancelled) setLocationOptions([])
    }).catch(() => { if (!cancelled) setLocationOptions([]) })
    return () => { cancelled = true }
  }, [usesLocationField, locationOptions])

  function updateFilter(newFilters, newLogic) {
    // COMMSFIX.B.3 — a disabled builder is read-only: belt-and-braces on top
    // of the disabled attributes below (SMSBroadcastEditor passes disabled
    // for locked/scheduled broadcasts; it used to be silently ignored).
    if (disabled) return
    onChange({ filters: newFilters, logic: newLogic || logic })
  }

  function addFilter() {
    // FILTER-P1.1 — the HOST decides the starting row. FUNNEL.1's blanket
    // `Stage = member` default was a defensible guess in a send composer and
    // actively harmful in a sequence: since SEQEXIT.1 the audience filter is a
    // CONTINUING condition re-checked before every step, so a click of "Add
    // filter" both narrowed enrolment to members and exited every non-member
    // mid-sequence. With no defaultFilterRow the row starts UNSET — inert
    // until the operator picks a field (see isUnsetFilterRow).
    if (disabled) return
    const newKey = mintRowKey()
    setRowKeyState(k => [...k, newKey])
    setFocusRowKey(newKey)
    updateFilter([
      ...filters,
      defaultFilterRow ? { ...defaultFilterRow } : { field: '', op: '', value: '' },
    ])
  }

  function removeFilter(index) {
    if (disabled) return
    const goneKey = rowKeys[index]
    setRowKeyState(k => k.filter((_, i) => i !== index))
    if (goneKey) {
      setEuroDrafts(d => { const next = { ...d }; delete next[goneKey]; return next })
      setPendingFields(p => { const next = { ...p }; delete next[goneKey]; return next })
      fieldNodes.current.delete(goneKey)
    }
    // FILTER-A.4 — land focus somewhere deterministic and MEANINGFUL: the row
    // that took this one's place if there is one, otherwise the row above,
    // otherwise "Add filter". Because rows carry stable keys, that target is
    // the filter the operator can see — not whatever inherited the index.
    const nextKey = rowKeys[index + 1] || rowKeys[index - 1] || '__add__'
    setFocusRowKey(nextKey)
    updateFilter(filters.filter((_, i) => i !== index))
  }

  function updateRow(index, updates) {
    const updated = filters.map((f, i) => (i === index ? { ...f, ...updates } : f))
    updateFilter(updated)
  }

  // FILTER-P1.4 — on a date field the value's SHAPE follows the op. Moving
  // between "after <date>" and "more than X days ago" without swapping the
  // value leaves a row that cannot be saved (an ISO date is not a day count,
  // and '30' is not a timestamp) — the server now rejects both, so fix it here
  // rather than let the operator hit a 400 they did not cause.
  function handleOpChange(index, newOp) {
    const current = filters[index]
    const fieldConfig = getFieldConfig(current?.field)
    if (fieldConfig?.type === 'date'
        && DAYS_SINCE_OPS.includes(newOp) !== DAYS_SINCE_OPS.includes(current?.op)) {
      updateRow(index, { op: newOp, value: defaultValueForDateOp(newOp) })
      return
    }
    updateRow(index, { op: newOp })
  }

  function handleFieldChange(index, newField) {
    if (disabled) return
    const rowKey = rowKeys[index]
    const clearPending = () => setPendingFields(p => {
      if (!(rowKey in p)) return p
      const next = { ...p }; delete next[rowKey]; return next
    })
    // FILTER-P1.1 — back to the placeholder: clear op + value too, or the row
    // keeps a stale predicate that no visible control explains.
    if (!newField) {
      clearPending()
      updateRow(index, { field: '', op: '', value: '' })
      return
    }
    const config = getFieldConfig(newField)
    if (!config) return // only reachable if the <select> ever carries an unknown value
    // FILTER-FOUND row 3 — a field whose value comes from a lookup is PENDING,
    // not applied. Writing the row now would seed value: '' and the count
    // endpoint would 400 the instant the field was picked, before the operator
    // touched anything else.
    if (AWAITS_A_VALUE.includes(config.type)) {
      setPendingFields(p => ({ ...p, [rowKey]: newField }))
      if (filters[index]?.field) updateRow(index, { field: '', op: '', value: '' })
      return
    }
    clearPending()
    const ops = opsForField(config)
    const defaultOp = ops[0]?.value || 'eq'
    const defaultValue = config.type === 'select' ? (config.options?.[0] || '')
      : config.type === 'boolean' ? 'true'
      // FILTER-P1.4 — never leave a fresh date row on an empty value.
      : config.type === 'date' ? defaultValueForDateOp(defaultOp)
      : ''
    updateRow(index, { field: newField, op: defaultOp, value: defaultValue })
  }

  // FILTER-A.4 — the accessible name for a row. "Filter 2 of 12" is the piece
  // a screen-reader user had NO way to get before: the row was a bare div, so
  // twelve identically-unnamed comboboxes were all the list amounted to.
  const rowLabel = (index) => (index > 0
    ? `${logic.toUpperCase()} — Filter ${index + 1} of ${filters.length}`
    : `Filter ${index + 1} of ${filters.length}`)

  // FILTER-FOUND row 3 — the pending field becomes a real row only now, once
  // it has a value the server resolvers will accept. Picking the blank option
  // leaves it pending rather than writing an empty row back.
  function commitPendingRow(index, field, value) {
    if (disabled || !value) return
    const config = getFieldConfig(field)
    if (!config) return
    setPendingFields(p => { const next = { ...p }; delete next[rowKeys[index]]; return next })
    updateRow(index, { field, op: opsForField(config)[0]?.value || 'eq', value })
  }

  function clearAllFilters() {
    if (disabled) return
    setRowKeyState([])
    setEuroDrafts({})
    setPendingFields({})
    fieldNodes.current.clear()
    setFocusRowKey('__add__')
    updateFilter([])
  }

  // FILTER-A.1 — a preset REPLACES the working filter with its rows. It is not
  // a mode: nothing is remembered, nothing is locked, and the operator is left
  // looking at ordinary editable rows. Deliberately no count on the chip — the
  // composer's count path is the only thing allowed to state a number, and it
  // states it after the rows land (see src/lib/audience-presets.js).
  function applyPreset(preset) {
    if (disabled) return
    const rows = presetFilter(preset).filters
    // A preset is a wholesale replacement, so every row is a new row.
    setRowKeyState(rows.map(() => mintRowKey()))
    setEuroDrafts({})
    updateFilter(rows, 'and')
  }

  return (
    <div className="space-y-4">
      {/* FILTER-A.1 — preset audiences. Opt-in per host: the send composer
          passes them, sequences and /contacts must not (a sequence audience is
          a CONTINUING condition, so these rows would mean something else). */}
      {presets?.length > 0 && (
        <div
          role="group"
          aria-label="Preset audiences"
          data-testid="audience-presets"
          className="flex flex-wrap items-center gap-1.5"
        >
          <span className="text-[11px] uppercase tracking-wider text-un1t-subtle flex items-center gap-1">
            <Sparkles size={11} aria-hidden="true" /> Presets
          </span>
          {presets.map(preset => (
            <button
              key={preset.id}
              type="button"
              disabled={disabled}
              onClick={() => applyPreset(preset)}
              title={preset.description}
              className="rounded-full border border-un1t-border px-3 py-1 text-xs text-un1t-subtle transition-colors hover:text-un1t-text focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text disabled:opacity-50"
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      {/* FILTER-A.4 — the governing ALL/ANY. It used to convey its state by
          BACKGROUND COLOUR alone with no aria-pressed and no group label, and
          at 30+ rows it scrolled off the top of the list while still governing
          every row below. Now: a named group of toggle buttons, and sticky. */}
      {filters.length > 1 && (
        <div
          role="group"
          aria-label="How these filters combine"
          data-testid="logic-toggle"
          className="sticky top-0 z-10 flex items-center gap-2 text-sm bg-un1t-bg py-1"
        >
          <span className="text-un1t-subtle">Match</span>
          <button
            type="button"
            aria-pressed={logic === 'and'}
            disabled={disabled}
            onClick={() => updateFilter(filters, 'and')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text disabled:opacity-50 ${
              logic === 'and' ? 'bg-un1t-text text-un1t-bg' : 'border border-un1t-border text-un1t-subtle hover:text-un1t-text'
            }`}
          >
            ALL filters
          </button>
          <button
            type="button"
            aria-pressed={logic === 'or'}
            disabled={disabled}
            onClick={() => updateFilter(filters, 'or')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text disabled:opacity-50 ${
              logic === 'or' ? 'bg-un1t-text text-un1t-bg' : 'border border-un1t-border text-un1t-subtle hover:text-un1t-text'
            }`}
          >
            ANY filter
          </button>
        </div>
      )}

      {/* Filter rows */}
      {filters.length === 0 && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-6 text-center">
          <Users size={28} className="mx-auto mb-2 text-un1t-subtle" />
          <p className="text-sm text-un1t-subtle mb-1">No filters — all opted-in contacts will receive this campaign</p>
          <p className="text-xs text-un1t-muted">Add filters to narrow your audience</p>
        </div>
      )}

      <div className="space-y-2">
        {filters.map((f, index) => {
          const fieldConfig = getFieldConfig(f.field)

          // FILTER-P1.1 — a row the operator has not given a field to yet.
          // Renders as a bare "Choose a field…" picker: no operator, no value,
          // and applyAudienceFilter compiles it to nothing, so it can neither
          // narrow an audience nor fail validation while it sits half-built.
          if (!f.field) {
            // FILTER-FOUND row 3 — the row may still be UNSET while carrying a
            // PENDING field: the operator picked "Behaviour tag" and has not
            // chosen which tag. Show the picker, keep the row inert.
            const rowKey = rowKeys[index]
            const pending = pendingFields[rowKey] || ''
            const pendingConfig = pending ? getFieldConfig(pending) : null
            return (
              <div key={rowKey} role="group" aria-label={rowLabel(index)} className="bg-un1t-surface border border-un1t-border rounded-lg p-3">
               <div className="flex flex-wrap items-center gap-2">
                <RowConnector index={index} logic={logic} />
                <FieldSelect
                  value={pending}
                  disabled={disabled}
                  inputRef={registerField(rowKey)}
                  describedBy={pendingConfig?.hint ? `${rowKey}-hint` : null}
                  onChange={e => handleFieldChange(index, e.target.value)}
                  cellClassName="flex-1"
                  className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text focus-visible:border-un1t-text w-full"
                />
                {pendingConfig && (
                  <DynamicValueSelect
                    type={pendingConfig.type}
                    value=""
                    disabled={disabled}
                    tagOptions={tagOptions} planOptions={planOptions} eventOptions={eventOptions} locationOptions={locationOptions}
                    onChange={e => commitPendingRow(index, pending, e.target.value)}
                  />
                )}
                <button
                  type="button"
                  aria-label={`Remove filter ${index + 1}`}
                  disabled={disabled}
                  onClick={() => removeFilter(index)}
                  className="p-1.5 text-un1t-muted hover:text-red-400 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text disabled:opacity-50"
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
               </div>
               {pendingConfig?.hint && (
                 <p id={`${rowKey}-hint`} className="mt-1.5 text-xs text-un1t-muted">{pendingConfig.hint}</p>
               )}
              </div>
            )
          }

          // COMMSFIX.B.3 — unknown/legacy saved field (lead_status, or a
          // library field not in FIELD_OPTIONS): render an inert warning row
          // instead of silently masquerading as the first field option. Only
          // the delete button is active; the count/populate side would throw
          // 'Unknown audience field' on this row anyway.
          if (!fieldConfig) {
            return (
              <div key={rowKeys[index]} role="group" aria-label={rowLabel(index)} className="bg-un1t-surface border border-amber-500/40 rounded-lg p-3">
               <div className="flex flex-wrap items-center gap-2">
                <RowConnector index={index} logic={logic} />
                <AlertTriangle size={14} className="text-amber-700 shrink-0" aria-hidden="true" />
                <span className="text-sm font-mono text-un1t-text">{f.field}</span>
                <span className="text-xs text-amber-700 flex-1">Saved with an unsupported field — remove this row</span>
                <button
                  type="button"
                  aria-label={`Remove filter ${index + 1}`}
                  disabled={disabled}
                  onClick={() => removeFilter(index)}
                  className="p-1.5 text-un1t-muted hover:text-red-400 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text disabled:opacity-50"
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
               </div>
              </div>
            )
          }

          const ops = opsForField(fieldConfig)
          const showValue = needsValue(f.op)
          const rowKey = rowKeys[index]
          const hintId = fieldConfig.hint ? `${rowKey}-hint` : null
          // FILTER-A.2 — a saved value that is no longer an offered option. A
          // bare <select> whose value matches no <option> renders BLANK, so
          // three live campaigns carrying the retired `active_member` stage
          // looked like an unset row while still filtering on it. Keep the
          // value selectable and say so out loud.
          const selectedTagDescription = fieldConfig.type === 'tag-select'
            ? (tagOptions || []).find(t => t.tag === f.value)?.description || null
            : null
          const retiredValue = fieldConfig.options && showValue
            && typeof f.value === 'string' && f.value !== ''
            && !fieldConfig.options.includes(f.value)
            ? f.value : null

          return (
            <div key={rowKey} role="group" aria-label={rowLabel(index)} className="bg-un1t-surface border border-un1t-border rounded-lg p-3">
             <div className="flex flex-wrap items-center gap-2">
              {/* Connector */}
              <RowConnector index={index} logic={logic} />

              {/* Field */}
              <FieldSelect
                value={f.field}
                disabled={disabled}
                inputRef={registerField(rowKey)}
                describedBy={hintId}
                onChange={e => handleFieldChange(index, e.target.value)}
                className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text focus-visible:border-un1t-text w-full"
              />

              {/* Operator */}
              <select
                value={f.op}
                aria-label="Condition"
                disabled={disabled}
                onChange={e => handleOpChange(index, e.target.value)}
                className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text focus-visible:border-un1t-text"
              >
                {ops.map(op => (
                  <option key={op.value} value={op.value}>{op.label}</option>
                ))}
              </select>

              {/* Value */}
              {showValue && fieldConfig.type === 'select' ? (
                <select
                  value={f.value}
                  aria-label="Value"
                  disabled={disabled} onChange={e => updateRow(index, { value: e.target.value })}
                  className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text focus-visible:border-un1t-text flex-1"
                >
                  {/* FILTER-A.2 — explicit display names. The old
                      replace(/_/g,' ') produced "classpass" and "pack member",
                      and left `time` reading as a date field when it means
                      monthly recurring — the exact value behind the 8-Aug
                      mis-send. */}
                  {fieldConfig.options?.map(opt => (
                    <option key={opt} value={opt}>
                      {fieldConfig.valueLabels?.[opt] || opt.replace(/_/g, ' ')}
                    </option>
                  ))}
                  {retiredValue && <option value={retiredValue}>{retiredValue} (retired)</option>}
                </select>
              ) : showValue && AWAITS_A_VALUE.includes(fieldConfig.type) ? (
                <DynamicValueSelect
                  type={fieldConfig.type}
                  value={f.value}
                  disabled={disabled}
                  tagOptions={tagOptions} planOptions={planOptions} eventOptions={eventOptions} locationOptions={locationOptions}
                  onChange={e => updateRow(index, { value: e.target.value })}
                />
              ) : showValue && fieldConfig.type === 'number' ? (
                <input
                  type="number"
                  aria-label="Value"
                  value={f.value}
                  disabled={disabled} onChange={e => updateRow(index, { value: e.target.value })}
                  className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text focus-visible:border-un1t-text w-24"
                />
              ) : showValue && fieldConfig.type === 'money' ? (
                // FILTER-A.2 — the operator types 120, we store 12000. The
                // draft holds the literal keystrokes so a half-typed decimal
                // ("12.") survives the cents round-trip instead of being
                // rewritten to "12" on the next render.
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-un1t-muted" aria-hidden="true">€</span>
                  {/* type=text, not number: a number input SANITISES its own
                      value, so "12." reads back as '' and the euro↔cent
                      round-trip wipes the decimal point the operator just
                      typed. inputMode keeps the numeric keypad on mobile. */}
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label="Value in euro"
                    data-testid="money-input"
                    value={euroDrafts[rowKey] ?? centsToEuroText(f.value)}
                    disabled={disabled}
                    onChange={e => {
                      const text = e.target.value
                      setEuroDrafts(d => ({ ...d, [rowKey]: text }))
                      updateRow(index, { value: euroTextToCents(text) })
                    }}
                    className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text focus-visible:border-un1t-text w-28"
                  />
                </div>
              ) : showValue && fieldConfig.type === 'date' ? (
                ['days_since_gt', 'days_since_lt'].includes(f.op) ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      aria-label="Number of days"
                      value={f.value}
                      disabled={disabled} onChange={e => updateRow(index, { value: e.target.value })}
                      placeholder="30"
                      className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text focus-visible:border-un1t-text w-20"
                    />
                    <span className="text-xs text-un1t-muted">days</span>
                  </div>
                ) : (
                  <input
                    type="date"
                    aria-label="Value"
                    value={f.value}
                    disabled={disabled} onChange={e => updateRow(index, { value: e.target.value })}
                    className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text focus-visible:border-un1t-text"
                  />
                )
              ) : showValue && fieldConfig.type === 'boolean' ? (
                <select
                  value={f.value === true || f.value === 'true' ? 'true' : 'false'}
                  aria-label="Value"
                  disabled={disabled} onChange={e => updateRow(index, { value: e.target.value })}
                  className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text focus-visible:border-un1t-text flex-1"
                >
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : showValue ? (
                <input
                  type="text"
                  aria-label="Value"
                  value={f.value}
                  disabled={disabled} onChange={e => updateRow(index, { value: e.target.value })}
                  placeholder="Value..."
                  className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text focus-visible:border-un1t-text flex-1"
                />
              ) : null}

              {/* Remove */}
              <button
                type="button"
                aria-label={`Remove filter ${index + 1}`}
                disabled={disabled}
                onClick={() => removeFilter(index)}
                className="p-1.5 text-un1t-muted hover:text-red-400 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text disabled:opacity-50"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
             </div>

              {/* FILTER-A.2 — disambiguating hint. Seven pairs in this list are
                  indistinguishable from their labels alone (Stage vs raw
                  Membership Status, the four membership-shaped selects, Last
                  Booked vs Last Attended, the three creation dates, Last
                  Payment vs Last Invoice). Two of them carry a data-quality
                  warning the operator has no other way to learn:
                  lead_created_at is poisoned, and the invoice table is stale. */}
              {fieldConfig.hint && (
                <p id={hintId} className="mt-1.5 text-xs text-un1t-muted">{fieldConfig.hint}</p>
              )}
              {/* FILTER-A.3 — the chosen tag's own description. /api/segments
                  has always returned it; the builder threw it away, leaving a
                  dropdown of bare column-like strings. A title attribute alone
                  would not reach a keyboard or screen-reader user. */}
              {fieldConfig.type === 'tag-select' && selectedTagDescription && (
                <p className="mt-1.5 text-xs text-un1t-subtle">{selectedTagDescription}</p>
              )}
              {retiredValue && (
                <p className="mt-1.5 text-xs text-amber-700 flex items-start gap-1.5">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>
                    <span className="font-mono">{retiredValue}</span> no longer exists as a value for this
                    field — it was saved before the option was retired and will match nobody. Pick a current value.
                  </span>
                </p>
              )}
            </div>
          )
        })}
      </div>

      {/* Add filter + count */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            ref={addButtonRef}
            disabled={disabled}
            onClick={addFilter}
            className="flex items-center gap-1.5 text-xs text-un1t-subtle hover:text-un1t-text transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text disabled:opacity-50"
          >
            <Plus size={14} aria-hidden="true" />
            Add filter
          </button>
          {/* FILTER-A.4 — at 30 rows the only way out was 30 clicks. */}
          {filters.length > 0 && (
            <button
              type="button"
              disabled={disabled}
              onClick={clearAllFilters}
              className="text-xs text-un1t-muted hover:text-un1t-text transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-text disabled:opacity-50"
            >
              Clear all
            </button>
          )}
        </div>

        {/* FILTER-A.4 — a LIVE region, and mounted unconditionally. A screen
            reader user editing a filter never heard the audience change, and a
            region that only appears once there is a number to show is not
            announced when that first number arrives. The `!= null` guard also
            covers the FILTER-B.1 omitted-prop case (now defaulted). */}
        <span aria-live="polite" aria-atomic="true" className="text-sm text-un1t-subtle">
          {audienceCount != null && (
            <>
              <Users size={14} className="inline mr-1.5" aria-hidden="true" />
              <strong className="text-un1t-text">{audienceCount}</strong> contacts match
            </>
          )}
        </span>
      </div>
    </div>
  )
}
