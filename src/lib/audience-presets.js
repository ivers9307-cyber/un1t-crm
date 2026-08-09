// FILTER-A.1 — preset audiences for the unified send composer.
//
// The standing sale audience ("everyone except monthly-recurring members") was
// folklore: an operator had to hunt through 39 field options and then KNOW that
// the Glofox value `time` means monthly recurring. On 8 August that folklore
// failed, and the correct filter turned out to differ from the obvious one —
// `is not time` returns 3,195 under the NULL-inclusive semantics shipped in
// #1310 versus 3,050 under the old NULL-excluding ones, so a hand-built version
// silently dropped 145 contacts. Presets exist so the correct filter is the one
// that is one click away.
//
// THREE RULES, all load-bearing:
//
// 1. A preset is a SHORTCUT, never a black box. Clicking one writes real rows
//    into the builder; the operator sees them, can edit them, and editing them
//    is not "breaking" the preset — there is no preset state to break.
//
// 2. A preset never carries a count. The verified live counts (Stillorgan,
//    2026-08-09, measured THROUGH the real per-location consent + email_status
//    + suppression gates) are in phase-A-builder-spec.md, and deliberately are
//    NOT copied here: a number baked into a chip drifts the moment a contact
//    joins, and a preset must never promise an audience the send cannot
//    deliver. The composer's existing count path is the only thing that may
//    state a number, and it states it AFTER the rows land. That is also why
//    "In arrears" needs no special handling: the cohort is 14, the reachable
//    audience is 12, and the count path reports the reachable one by
//    construction.
//
// 3. Presets belong to the SEND COMPOSER only. A sequence audience is a
//    CONTINUING condition (re-checked before every step since SEQEXIT.1) and
//    /contacts is a browsing filter — the same rows mean something different
//    there, so the chips are opt-in per host (AudienceBuilder `presets` prop).

/**
 * Verified preset definitions. `filters` rows are exactly the shape the
 * builder writes by hand — same field names, same op strings, same string
 * values — so a preset row and a hand-built row are indistinguishable
 * downstream.
 */
export const AUDIENCE_PRESETS = Object.freeze([
  {
    id: 'everyone_emailable',
    label: 'Everyone we can email',
    // No rows at all: the send path's per-location consent + email_status +
    // suppression gates already define "can email". Adding a consent row here
    // would double-gate and is impossible anyway (no consent field exists in
    // AUDIENCE_FIELDS — deferred by design).
    description: 'No conditions — consent, bounces and suppression do the work.',
    filters: Object.freeze([]),
  },
  {
    id: 'except_monthly_members',
    label: 'Everyone except monthly members',
    // `time` is the Glofox membership type for a monthly RECURRING
    // subscription. `neq` here is NULL-inclusive (FILTER-P1.2), which is the
    // entire point: contacts with an unsynced membership type are people we
    // can email, and the naive predicate drops them.
    description: 'Excludes monthly recurring memberships (Glofox type “time”), including contacts whose type has never synced.',
    filters: Object.freeze([
      Object.freeze({ field: 'glofox_membership_type', op: 'neq', value: 'time' }),
    ]),
  },
  {
    id: 'members',
    label: 'Members',
    description: 'Contacts sitting at the Member stage of the funnel.',
    filters: Object.freeze([
      Object.freeze({ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }),
    ]),
  },
  {
    id: 'dormant',
    label: 'Dormant (win-back)',
    description: 'Contacts the funnel has classified as dormant — the win-back pool.',
    filters: Object.freeze([
      Object.freeze({ field: 'pipeline_stage_slug', op: 'eq', value: 'dormant' }),
    ]),
  },
  {
    id: 'pack_members',
    label: 'Pack members',
    description: 'Contacts on a class pack rather than a recurring membership.',
    filters: Object.freeze([
      Object.freeze({ field: 'pipeline_stage_slug', op: 'eq', value: 'pack_member' }),
    ]),
  },
  {
    id: 'in_arrears',
    label: 'In arrears',
    // 'locked' is the Glofox membership state for payment arrears (the churn
    // radar's Overdue tab). Note the cohort is larger than the audience —
    // some overdue members are not email-reachable — and the count path is
    // what reconciles the two.
    description: 'Memberships Glofox has locked for payment arrears.',
    filters: Object.freeze([
      Object.freeze({ field: 'glofox_membership_state', op: 'eq', value: 'locked' }),
    ]),
  },
  {
    id: 'sent_never_opened',
    label: 'Sent but never opened',
    // total_emails_opened was frozen at zero until mig 508 backfilled it, so
    // this preset only became meaningful after that backfill.
    description: 'We have emailed them at least once and they have never opened one.',
    filters: Object.freeze([
      Object.freeze({ field: 'total_emails_sent', op: 'gt', value: '0' }),
      Object.freeze({ field: 'total_emails_opened', op: 'eq', value: '0' }),
    ]),
  },
])

/**
 * Turn a preset into the filter JSON the builder holds.
 *
 * Always AND: every multi-row preset above is a conjunction, and the builder's
 * ALL/ANY toggle stays free for the operator to change afterwards. Rows are
 * cloned because the registry is frozen and the builder's rows are mutable —
 * without the clone the first edit after a preset click would throw in strict
 * mode and silently no-op otherwise.
 *
 * @param {{ filters: Array<{field:string,op:string,value:*}> }} preset
 * @returns {{ logic: 'and', filters: Array<object> }}
 */
export function presetFilter(preset) {
  return {
    logic: 'and',
    filters: (preset?.filters || []).map(row => ({ ...row })),
  }
}
