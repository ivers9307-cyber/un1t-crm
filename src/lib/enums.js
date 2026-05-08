// Single source of truth for status / type enums that live as
// Postgres CHECK (col IN (...)) constraints. The runtime DB has
// the authoritative copy; these constants mirror that copy so the
// JS layer stops sprinkling magic strings around (and so a typo
// like `'stopped_off'` breaks at lint/test time instead of at 3am
// when a webhook fires).
//
// Convention:
//   • `<table>_<col>` keyed object whose values match the CHECK list
//     character-for-character.
//   • A frozen-Object copy is used so callers can't accidentally
//     mutate the constant set.
//   • An `*_VALUES` array sibling lists every value as a tuple,
//     which is what `.in('status', X)` queries want.
//
// When you change a CHECK constraint in a migration, update this
// file in the same PR. The unit test in enums.test.js asserts that
// every constant set is non-empty + has unique values; a follow-up
// task will add a once-a-release sanity check that compares to the
// live `pg_constraint` definitions.

// ── ac_sessions.status (mig 103) ──────────────────────────────────
// Lifecycle of an AC session row created by the studio-management
// "turn on" route. Only `on` and `extended` are considered live —
// see ac_sessions_active_status_idx.
export const AC_SESSION_STATUS = Object.freeze({
  ON: 'on',
  AUTO_OFF: 'auto_off',     // auto-off cron timed-out and stopped it
  MANUAL_OFF: 'manual_off', // human (or wall-panel) stopped it
  EXTENDED: 'extended',     // /extend route bumped auto_off_at
  FAILED: 'failed',         // turn-on succeeded in DB but Sensibo errored
})
export const AC_SESSION_STATUS_VALUES = Object.values(AC_SESSION_STATUS)
export const AC_SESSION_ACTIVE_STATUSES = Object.freeze([
  AC_SESSION_STATUS.ON, AC_SESSION_STATUS.EXTENDED,
])

// ── contracts.status (mig 106) ────────────────────────────────────
// Issued → recipient may View or Sign. Decline + revoke are
// terminal in opposite directions.
export const CONTRACT_STATUS = Object.freeze({
  DRAFT: 'draft',
  ISSUED: 'issued',
  VIEWED: 'viewed',
  SIGNED: 'signed',
  DECLINED: 'declined',
  REVOKED: 'revoked',
})
export const CONTRACT_STATUS_VALUES = Object.values(CONTRACT_STATUS)
// Statuses that still display in a recipient's "pending contracts"
// banner — anything they could still take action on.
export const CONTRACT_PENDING_STATUSES = Object.freeze([
  CONTRACT_STATUS.ISSUED, CONTRACT_STATUS.VIEWED,
])

// ── contractor_invoices.status (migs 101, 102) ────────────────────
// submitted → approved | declined. Revoked covers the post-approval
// undo path (mig 102).
export const CONTRACTOR_INVOICE_STATUS = Object.freeze({
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  DECLINED: 'declined',
  REVOKED: 'revoked',
})
export const CONTRACTOR_INVOICE_STATUS_VALUES =
  Object.values(CONTRACTOR_INVOICE_STATUS)

// ── orders.status (mig 085) ───────────────────────────────────────
// Drives the orders ledger + tag rules engine. `recovered` is for
// the dunning flow (failed payment → contact pays later).
export const ORDER_STATUS = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABANDONED: 'abandoned',
  REFUNDED: 'refunded',
  RECOVERED: 'recovered',
})
export const ORDER_STATUS_VALUES = Object.values(ORDER_STATUS)

// ── orders.source_type (mig 085) ──────────────────────────────────
// Which feature emitted the order row. Used by the tag rules engine
// to route tag mappings + by /orders to render a per-source link.
export const ORDER_SOURCE_TYPE = Object.freeze({
  RACE_REGISTRATION: 'race_registration',
  CAR_DEPOSIT: 'car_deposit',
})
export const ORDER_SOURCE_TYPE_VALUES = Object.values(ORDER_SOURCE_TYPE)

// ── race_payments.status (mig 084) ────────────────────────────────
// Same shape as orders but with no `recovered` (race payments don't
// have a dunning flow yet — contacts re-register from scratch).
export const RACE_PAYMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABANDONED: 'abandoned',
  REFUNDED: 'refunded',
})
export const RACE_PAYMENT_STATUS_VALUES = Object.values(RACE_PAYMENT_STATUS)

// ── race_registrations.status (mig 082 + 084) ─────────────────────
// `pending_payment` was added by mig 084 for paid races (need to
// receive Revolut webhook before confirming).
export const RACE_REGISTRATION_STATUS = Object.freeze({
  PENDING_PAYMENT: 'pending_payment',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  NO_SHOW: 'no_show',
})
export const RACE_REGISTRATION_STATUS_VALUES =
  Object.values(RACE_REGISTRATION_STATUS)

// ── time_off.status (mig 011) ─────────────────────────────────────
export const TIME_OFF_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
})
export const TIME_OFF_STATUS_VALUES = Object.values(TIME_OFF_STATUS)

// ── time_off.type (mig 011) ───────────────────────────────────────
export const TIME_OFF_TYPE = Object.freeze({
  HOLIDAY: 'holiday',
  SICK: 'sick',
  UNAVAILABLE: 'unavailable',
})
export const TIME_OFF_TYPE_VALUES = Object.values(TIME_OFF_TYPE)

// ── profiles.employment_type (migs 012, 070, 106) ─────────────────
// `both` only exists on contract_templates.employment_type — never
// stored on profiles. See EMPLOYMENT_TYPE_FOR_TEMPLATE below.
export const EMPLOYMENT_TYPE = Object.freeze({
  FTE: 'fte',
  CONTRACTOR: 'contractor',
})
export const EMPLOYMENT_TYPE_VALUES = Object.values(EMPLOYMENT_TYPE)

// ── contract_templates.employment_type (mig 106) ──────────────────
// Templates can target a specific employment type or 'both'; profiles
// can only ever be 'fte' or 'contractor'.
export const EMPLOYMENT_TYPE_FOR_TEMPLATE = Object.freeze({
  FTE: 'fte',
  CONTRACTOR: 'contractor',
  BOTH: 'both',
})
export const EMPLOYMENT_TYPE_FOR_TEMPLATE_VALUES =
  Object.values(EMPLOYMENT_TYPE_FOR_TEMPLATE)

// ── profile_locations.role (mig 051) ──────────────────────────────
// 'master' is intentionally NOT here — master is a separate boolean
// (profile_locations.is_master, mig 080) so a user can hold a
// per-location role AND be a master.
export const LOCATION_ROLE = Object.freeze({
  OWNER: 'owner',
  MANAGER: 'manager',
  HEAD_COACH: 'head_coach',
  STAFF: 'staff',
})
export const LOCATION_ROLE_VALUES = Object.values(LOCATION_ROLE)

// ── device_tokens.platform (mig 023) ──────────────────────────────
export const DEVICE_PLATFORM = Object.freeze({
  IOS: 'ios',
  ANDROID: 'android',
  WEB: 'web',
})
export const DEVICE_PLATFORM_VALUES = Object.values(DEVICE_PLATFORM)

// ── cars.status (mig 025) ─────────────────────────────────────────
export const CAR_STATUS = Object.freeze({
  NEW: 'new',
  PENDING: 'pending',
  COMPLETED: 'completed',
})
export const CAR_STATUS_VALUES = Object.values(CAR_STATUS)

// ── cars.deposit_status (mig 046) ─────────────────────────────────
// Lifecycle of a deposit-link issued from /cars/[id].
// `null` is also valid — means no link issued yet. Always check for
// null first when narrowing.
export const CAR_DEPOSIT_STATUS = Object.freeze({
  SENT: 'sent',
  TERMS_ACCEPTED: 'terms_accepted',
  PAID: 'paid',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
})
export const CAR_DEPOSIT_STATUS_VALUES = Object.values(CAR_DEPOSIT_STATUS)

// ── contact_imports.status (migs 095, 096) ────────────────────────
export const CONTACT_IMPORT_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  ROLLING_BACK: 'rolling_back',
  ROLLED_BACK: 'rolled_back',
  FAILED: 'failed',
})
export const CONTACT_IMPORT_STATUS_VALUES =
  Object.values(CONTACT_IMPORT_STATUS)

// ── contact_import_rows.action (mig 095) ──────────────────────────
export const CONTACT_IMPORT_ROW_ACTION = Object.freeze({
  CREATED: 'created',
  UPDATED: 'updated',
  SKIPPED: 'skipped',
  ERRORED: 'errored',
  ROLLED_BACK: 'rolled_back',
})
export const CONTACT_IMPORT_ROW_ACTION_VALUES =
  Object.values(CONTACT_IMPORT_ROW_ACTION)

// ── team_members.role (mig 081) ───────────────────────────────────
export const TEAM_MEMBER_ROLE = Object.freeze({
  CAPTAIN: 'captain',
  MEMBER: 'member',
})
export const TEAM_MEMBER_ROLE_VALUES = Object.values(TEAM_MEMBER_ROLE)
