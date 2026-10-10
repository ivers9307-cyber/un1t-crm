// W1.M3a — the ONE gate a Glofox-only web surface renders through.
//
// Server-component friendly (no hooks, no directive): a page awaits
// membershipStateForPage(db, locationId) and passes the answer in. The
// gate renders its children only when the source is CONFIGURED and
// provides `capability`; otherwise it draws one of four copies:
//
//   none          "No membership source connected" (+ a link to the
//                 setting for an owner/master, "Ask an owner" for others)
//   unconfigured  "<Provider> is selected but not fully configured"
//                 (+ what is missing)
//   unknown       "Membership data could not be read right now" —
//                 a RETRY message, never the none copy: an operator must
//                 not be sent to connect an integration that is merely
//                 unreadable this second
//   configured but without the capability
//                 "<Provider> does not provide <what>"
//   no_location   "Choose a location" (no active studio to ask about)
//
// A missing `state` is unknown, never none (a page that forgot to pass it
// cannot accidentally tell a live studio it has no source).
//
// STAFF surface only: these pages are behind staff permissions. Nothing
// here reaches a customer, and the gate must never be used to render
// class/event capacity to one.
import Link from 'next/link'
import EmptyState from '@/components/ui/EmptyState'

/** What each capability means in the copy ("…no membership data to show"). */
const CAPABILITY_COPY = Object.freeze({
  memberships: { noun: 'membership data', need: 'no membership data to show' },
  bookings: { noun: 'booking data', need: 'no booking data to show' },
  credits: { noun: 'credit balances', need: 'no credit balances to show' },
  invoices: { noun: 'invoice data', need: 'no invoice data to show' },
  schedule: { noun: 'a class schedule', need: 'no class schedule to run on' },
})

const UNKNOWN_STATE = Object.freeze({ source: null, state: 'unknown', label: 'No membership source', capabilities: {} })

function ManageLine({ canManage, settingsHref, verb }) {
  if (canManage && settingsHref) {
    return <>{verb} <Link href={settingsHref} className="underline">Location settings → Integrations</Link>.</>
  }
  return <>Ask an owner to connect a membership source.</>
}

/**
 * @param {object} props
 * @param {{ source: string|null, state: string, missing?: string[], label?: string, capabilities?: object }} [props.state]
 * @param {'memberships'|'bookings'|'credits'|'invoices'|'schedule'} [props.capability]
 * @param {string} [props.settingsHref]   membershipSettingsHref(locationId)
 * @param {boolean} [props.canManage]     canManageMembershipSource(user, locationId)
 * @param {'none'|'sm'|'md'|'lg'} [props.padding]
 */
export default function MembershipSourceGate({ state, capability = 'memberships', settingsHref, canManage = false, padding = 'lg', className, children }) {
  const s = state && typeof state.state === 'string' ? state : UNKNOWN_STATE
  const cap = CAPABILITY_COPY[capability] || CAPABILITY_COPY.memberships
  const label = s.label || s.source || 'The membership source'

  if (s.state === 'configured') {
    if (s.capabilities?.[capability] !== false) return children
    return (
      <EmptyState
        data-membership-state="configured"
        padding={padding}
        className={className}
        title={`${label} does not provide ${cap.noun}`}
        description={<>This view needs a membership source with {cap.noun}. <ManageLine canManage={canManage} settingsHref={settingsHref} verb="Choose one in" /></>}
      />
    )
  }

  if (s.state === 'unconfigured') {
    const missing = Array.isArray(s.missing) && s.missing.length ? s.missing.join(', ') : 'its credentials'
    return (
      <EmptyState
        data-membership-state="unconfigured"
        padding={padding}
        className={className}
        title={`${label} is selected but not fully configured`}
        description={<>Missing: {missing}. <ManageLine canManage={canManage} settingsHref={settingsHref} verb="Finish setting it up in" /></>}
      />
    )
  }

  if (s.state === 'no_location') {
    return (
      <EmptyState
        data-membership-state="no_location"
        padding={padding}
        className={className}
        title="Choose a location"
        description={`Pick a studio to see its ${cap.noun}.`}
      />
    )
  }

  if (s.state === 'none') {
    return (
      <EmptyState
        data-membership-state="none"
        padding={padding}
        className={className}
        title="No membership source connected"
        description={<>This studio has no membership source, so there is {cap.need}. <ManageLine canManage={canManage} settingsHref={settingsHref} verb="Choose one in" /></>}
      />
    )
  }

  // unknown (and anything unrecognised): a retry, never "no source".
  return (
    <EmptyState
      data-membership-state="unknown"
      padding={padding}
      className={className}
      title="Membership data could not be read right now"
      description="Reload to try again. The membership source is not missing; it could not be checked."
    />
  )
}
