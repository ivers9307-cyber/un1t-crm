// GLOFOX2.9 — consolidated Glofox Profile card. Single rich panel
// absorbing every Glofox-synced field — status, credits, LTV,
// tenure, engagement, last payment, upcoming + recent bookings,
// DOB, Glofox ID. Always rendered (every CRM contact should also
// exist in Glofox under the bidirectional-sync model — when not
// yet linked, shows an empty state with a hint instead of being
// hidden).
//
// Operator gets a one-glance view of the member's whole Glofox
// relationship without scrolling between cards.
//
// CC.1 — moved verbatim from /contacts/[id]/page.js (it was a
// file-local function there) so the command-centre layout can compose
// it; shared format helpers now come from ./format.

import CreateInGlofoxButton from '@/components/CreateInGlofoxButton'
import { relativeTime, formatMoney, formatDate } from './format'

const GLOFOX_STATUS_META = {
  cold:           { label: 'Cold',                  cls: 'bg-gray-500/20    text-gray-700    border-gray-500/30' },
  tour:           { label: 'Tour booked',           cls: 'bg-blue-500/20    text-blue-700    border-blue-500/30' },
  no_sale_tour:   { label: 'No sale (tour)',        cls: 'bg-amber-500/20   text-amber-700   border-amber-500/30' },
  trial:          { label: 'Trial',                 cls: 'bg-blue-500/20    text-blue-700    border-blue-500/30' },
  no_sale_trial:  { label: 'No sale (trial)',       cls: 'bg-amber-500/20   text-amber-700   border-amber-500/30' },
  member:         { label: 'Member',                cls: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/30' },
  credit_member:  { label: 'Credit Member',         cls: 'bg-teal-500/20    text-teal-700    border-teal-500/30' },
  classpass_payg: { label: 'ClassPass PAYG',        cls: 'bg-purple-500/20  text-purple-700  border-purple-500/30' },
  ex_member:      { label: 'Ex-member',             cls: 'bg-red-500/20     text-red-700     border-red-500/30' },
  lead:           { label: 'Lead',                  cls: 'bg-gray-500/20    text-gray-700    border-gray-500/30' },
}

// GLOFOX-PLAN-BLOCK (Stage 1b) -- LIVE membership lifecycle state
// (membership.status), distinct from the operator-facing lead_status
// above. The "real member vs Glofox member" signal: Glofox keeps
// lead_status='member' even when the subscription has lapsed or been
// frozen for non-payment, so the live state is how the operator spots
// a misclassification. Glofox 'locked' = frozen on a failed payment.
const GLOFOX_STATE_META = {
  active: { label: 'Active',   cls: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/30' },
  paused: { label: 'Paused',   cls: 'bg-amber-500/20   text-amber-700   border-amber-500/30' },
  locked: { label: 'Overdue',  cls: 'bg-red-500/20     text-red-700     border-red-500/30' },
  // GLOFOX-CLASSIFY.2 — 'future' = a Glofox membership/trial that hasn't
  // started yet. For a trial this means the account exists but the first
  // class is unbooked (the trial only "starts" on first booking); for a
  // paid membership it's a genuine upcoming start date. Surfaced so the
  // operator can tell an unstarted signup from a live member.
  future: { label: 'Upcoming', cls: 'bg-blue-500/20    text-blue-700    border-blue-500/30' },
}

function formatTenure(joinedAtIso) {
  if (!joinedAtIso) return null
  const ms = Date.now() - new Date(joinedAtIso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const days = Math.floor(ms / 86_400_000)
  if (days < 30) return `Joined ${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30.44)
  if (months < 12) return `Joined ${months} month${months === 1 ? '' : 's'} ago`
  const years = Math.floor(months / 12)
  const remMonths = months % 12
  return `Joined ${years}y${remMonths ? ` ${remMonths}mo` : ''} ago`
}

// Glofox membership.type → human label.
const MEMBERSHIP_TYPE_LABEL = {
  time: 'Subscription',
  num_classes: 'Class pack',
  payg: 'Pay as you go',
}

// Title-case a Glofox slug-ish value ("direct_debit" → "Direct debit").
function humanise(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const s = value.trim().replace(/[_-]+/g, ' ').toLowerCase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Normalise one Glofox sign-up answer into { q, a }. The payload
// shape varies between forms, so handle the common key spellings
// defensively and drop anything we can't render as plain text.
function normaliseAnswer(raw) {
  if (!raw || typeof raw !== 'object') return null
  const q = raw.question ?? raw.label ?? raw.name ?? raw.title ?? null
  let a = raw.answer ?? raw.value ?? raw.response ?? raw.text ?? null
  if (Array.isArray(a)) a = a.join(', ')
  if (a != null && typeof a === 'object') return null
  if (a == null || String(a).trim() === '') return null
  return { q: q ? String(q) : null, a: String(a).trim() }
}

export default function GlofoxProfileCard({ contact }) {
  const linked = Boolean(contact.glofox_member_id)
  const statusMeta = GLOFOX_STATUS_META[contact.glofox_membership_status] || null
  const stateMeta = GLOFOX_STATE_META[contact.glofox_membership_state] || null
  const tenure = formatTenure(contact.joined_at)
  const lastAttended = relativeTime(contact.last_attended_at)
  const lastPayment = relativeTime(contact.last_payment_at)
  const ltv = Number.isFinite(contact.lifetime_value_cents) && contact.lifetime_value_cents > 0
    ? formatMoney(contact.lifetime_value_cents, contact.lifetime_currency)
    : null
  const credits = contact.trial_credits_remaining

  // GLOFOX-PROFILE (mig 196) — wider profile data captured by the
  // nightly attendance refresh: billing detail, renewal cliff,
  // payment + sign-up attributes.
  const price = Number.isFinite(contact.glofox_membership_price_cents) && contact.glofox_membership_price_cents > 0
    ? formatMoney(contact.glofox_membership_price_cents, contact.lifetime_currency)
    : null
  const interval = contact.glofox_billing_interval || null
  const membershipType = MEMBERSHIP_TYPE_LABEL[contact.glofox_membership_type]
    || humanise(contact.glofox_membership_type)
  const paymentMethod = humanise(contact.glofox_payment_method)
  const source = humanise(contact.glofox_source)
  const expiryDate = formatDate(contact.glofox_membership_expiry)
  const expiryRel = relativeTime(contact.glofox_membership_expiry)
  const expiryPast = contact.glofox_membership_expiry
    ? new Date(contact.glofox_membership_expiry).getTime() < Date.now()
    : false
  // Price + cadence onto one line: "€120 / 6 months · Subscription".
  const billingLine = [
    price && interval ? `${price} / ${interval}` : price || (interval ? `Billed every ${interval}` : null),
    membershipType,
  ].filter(Boolean).join(' · ')
  const answers = Array.isArray(contact.glofox_signup_answers)
    ? contact.glofox_signup_answers.map(normaliseAnswer).filter(Boolean)
    : []

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Glofox membership</h3>
        {linked && (
          <span className="text-[10px] text-un1t-muted">
            Synced {contact.glofox_synced_at ? relativeTime(contact.glofox_synced_at) : 'never'}
          </span>
        )}
      </div>

      {!linked && (
        <div className="space-y-2">
          <div className="text-sm text-un1t-muted py-2 text-center">
            Not yet linked to Glofox.
            <p className="text-xs mt-1">Push this contact to Glofox: we&apos;ll search by email first, and create + attach the trial if they don&apos;t exist yet.</p>
          </div>
          <CreateInGlofoxButton contact={contact} />
        </div>
      )}

      {linked && (
        <>
          {/* Status row — badge + headline numbers */}
          <div className="flex items-center gap-2 flex-wrap">
            {statusMeta ? (
              <span className={`text-xs px-2 py-0.5 rounded-full border ${statusMeta.cls}`}>
                {statusMeta.label}
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-700 border border-gray-500/30">
                {contact.glofox_membership_status || 'Unknown'}
              </span>
            )}
            {stateMeta && (
              <span className={`text-xs px-2 py-0.5 rounded-full border ${stateMeta.cls}`}>
                {stateMeta.label}
              </span>
            )}
            {credits != null && (
              <span className="text-xs text-un1t-subtle">· {credits} credit{credits === 1 ? '' : 's'}</span>
            )}
            {ltv && (
              <span className="text-xs text-un1t-subtle">· {ltv} LTV</span>
            )}
          </div>

          {/* Current membership plan (CHURN-PREP.2). GLOFOX-PLANNAME.1 —
              clean canonical name as the headline; the full Glofox catalog
              name (promo/discount context) as a subtitle when it differs. */}
          {contact.glofox_membership_plan && (
            <div>
              <p className="text-sm font-medium text-un1t-text">{contact.glofox_membership_plan}</p>
              {contact.glofox_membership_plan_full
                && contact.glofox_membership_plan_full !== contact.glofox_membership_plan && (
                <p className="text-xs text-un1t-subtle">{contact.glofox_membership_plan_full}</p>
              )}
              {contact.membership_description && (
                <p className="text-xs text-un1t-muted whitespace-pre-line mt-1">{contact.membership_description}</p>
              )}
            </div>
          )}

          {/* Billing + renewal (GLOFOX-PROFILE) */}
          {billingLine && (
            <p className="text-xs text-un1t-subtle">{billingLine}</p>
          )}
          {expiryDate && (
            <p className={`text-xs ${expiryPast ? 'text-red-400/90' : 'text-un1t-subtle'}`}>
              {expiryPast ? 'Expired' : 'Renews'} {expiryDate}
              {expiryRel && <span className="text-un1t-muted"> · {expiryRel}</span>}
            </p>
          )}

          {/* Tenure + engagement strip */}
          <div className="text-xs text-un1t-subtle space-y-1">
            {tenure && <p>{tenure}</p>}
            {lastAttended && <p>Last attended {lastAttended}</p>}
            {Number(contact.total_attended_30d) > 0 && (
              <p>
                {contact.total_attended_30d} attended in last 30d
                {Number(contact.total_noshow_30d) > 0 && (
                  <span className="text-amber-400/80"> · {contact.total_noshow_30d} no-show{contact.total_noshow_30d === 1 ? '' : 's'}</span>
                )}
              </p>
            )}
            {lastPayment && contact.lifetime_transaction_count > 0 && (
              <p>Last paid {lastPayment} · {contact.lifetime_transaction_count} payment{contact.lifetime_transaction_count === 1 ? '' : 's'} total</p>
            )}
          </div>

          {/* Bookings sub-section */}
          {Array.isArray(contact.recent_bookings) && contact.recent_bookings.length > 0 && (
            <BookingsSubsection bookings={contact.recent_bookings} />
          )}

          {/* Sign-up answers (GLOFOX-PROFILE) — goals, referral
              source etc. captured on the Glofox join form. */}
          {answers.length > 0 && (
            <div className="pt-2 border-t border-un1t-border">
              <p className="text-[10px] uppercase tracking-wider text-un1t-muted mb-1.5">Sign-up answers</p>
              <div className="space-y-1">
                {answers.map((ans, i) => (
                  <p key={i} className="text-xs leading-snug">
                    {ans.q && <span className="text-un1t-muted">{ans.q}: </span>}
                    <span className="text-un1t-subtle">{ans.a}</span>
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* Reference info — profile attributes + identifiers */}
          <div className="pt-2 border-t border-un1t-border text-[11px] text-un1t-muted space-y-0.5">
            {contact.dob && <p>DOB: {contact.dob}</p>}
            {contact.gender && <p>Gender: {humanise(contact.gender)}</p>}
            {contact.emergency_contact && <p>Emergency contact: {contact.emergency_contact}</p>}
            {paymentMethod && <p>Payment method: {paymentMethod}</p>}
            {source && <p>Source: {source}</p>}
            {(contact.glofox_roaming_enabled === true || contact.glofox_account_active === false) && (
              <p>
                {contact.glofox_roaming_enabled === true && (
                  <span className="text-teal-400/80">Roaming enabled</span>
                )}
                {contact.glofox_roaming_enabled === true && contact.glofox_account_active === false && ' · '}
                {contact.glofox_account_active === false && (
                  <span className="text-red-400/80">Account inactive</span>
                )}
              </p>
            )}
            <p className="font-mono truncate">ID: {contact.glofox_member_id}</p>
          </div>
        </>
      )}
    </div>
  )
}

function BookingsSubsection({ bookings }) {
  const nowSec = Math.floor(Date.now() / 1000)
  const upcoming = bookings.filter(b => Number(b.time_start) > nowSec)
                           .sort((a, b) => Number(a.time_start) - Number(b.time_start))
  const past = bookings.filter(b => Number(b.time_start) <= nowSec)
                       .sort((a, b) => Number(b.time_start) - Number(a.time_start))
  if (upcoming.length === 0 && past.length === 0) return null
  return (
    <div className="pt-2 border-t border-un1t-border space-y-3">
      {upcoming.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-un1t-muted mb-1.5">Upcoming</p>
          <div className="space-y-1.5">
            {upcoming.map(b => <BookingRow key={b.glofox_id || b.time_start} b={b} when="future" />)}
          </div>
        </div>
      )}
      {past.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-un1t-muted mb-1.5">Recent</p>
          <div className="space-y-1.5">
            {past.map(b => <BookingRow key={b.glofox_id || b.time_start} b={b} when="past" />)}
          </div>
        </div>
      )}
    </div>
  )
}

function BookingRow({ b, when }) {
  const status = String(b.status || '').toUpperCase()
  const isCancelled = status === 'CANCELED' || status === 'CANCELLED'
  let badge = null
  if (isCancelled) {
    badge = { label: 'Cancelled', cls: 'bg-red-500/20 text-red-700' }
  } else if (status === 'WAITING') {
    badge = { label: 'Waitlist', cls: 'bg-purple-500/20 text-purple-700' }
  } else if (when === 'past' && status === 'BOOKED') {
    badge = b.attended === true
      ? { label: 'Attended', cls: 'bg-green-500/20 text-green-700' }
      : { label: 'No-show',  cls: 'bg-amber-500/20 text-amber-700' }
  } else if (when === 'future' && status === 'BOOKED') {
    badge = { label: 'Booked', cls: 'bg-blue-500/20 text-blue-700' }
  }
  const ts = Number(b.time_start) ? new Date(Number(b.time_start) * 1000) : null
  const dateStr = ts
    ? ts.toLocaleString('en-IE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : ''
  return (
    <div className="flex items-start justify-between text-sm gap-2">
      <div className="min-w-0 flex-1">
        <p className={`font-medium truncate ${isCancelled ? 'line-through text-un1t-muted' : ''}`}>
          {b.event_name || b.model_name || '—'}
        </p>
        <p className="text-xs text-un1t-muted">{dateStr}</p>
      </div>
      {badge && (
        <span className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap ${badge.cls}`}>
          {badge.label}
        </span>
      )}
    </div>
  )
}
