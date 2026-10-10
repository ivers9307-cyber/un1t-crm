// W1.M3c — what the phone's Business and Studio dashboards draw for a
// studio's membership source. The phone twin of the web
// MembershipSourceGate (src/components/MembershipSourceGate.jsx, W1.M3a):
// same states, same words. Decisions live here, not in the components
// (there is no RN component test runner); the components only render.
//
// The state is SERVER-JUDGED: /api/dashboard/business and
// /api/dashboard/studio-contacts carry `membership_source`
// ({ source, state, label, missing?, provides_memberships, can_manage },
// membershipStatePayload in src/lib/membership/state-for-page.js). The
// phone never guesses "configured" from a settings slice.
//
//   none          "No membership source connected"
//   unconfigured  "<Provider> is selected but not fully configured" + Missing: …
//   unknown       "Membership data could not be read right now": a RETRY,
//                 never the none copy (a studio whose source is merely
//                 unreadable this second must not be told to connect one)
//   no_location   "Choose a location"
//   configured    nothing: the numbers render exactly as before
//
// A payload WITHOUT the key comes from a server older than this bundle (the
// OTA can land before the web deploy). readMembershipSource() reports it as
// { state: 'unknown', reported: false }, never none, and the views below
// render the screen as it was before W1.M3c rather than a retry card over a
// configured studio's numbers.
//
// Staff screens only. Copy carries no em-dashes.

const KNOWN_STATES = new Set(['none', 'configured', 'unconfigured', 'unknown', 'no_location'])

const NOT_REPORTED = Object.freeze({
  source: 'unknown',
  state: 'unknown',
  label: null,
  missing: [],
  providesMemberships: true,
  canManage: false,
  reported: false,
})

/**
 * Normalise a payload's `membership_source`. Absent or malformed → unknown
 * (reported: false), never none. A state string this bundle does not know
 * (a newer server) is unknown too, but reported: the retry card shows.
 */
export function readMembershipSource(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.state !== 'string') return NOT_REPORTED
  const state = KNOWN_STATES.has(raw.state) ? raw.state : 'unknown'
  return {
    source: typeof raw.source === 'string' ? raw.source : (state === 'unknown' ? 'unknown' : null),
    state,
    label: typeof raw.label === 'string' && raw.label ? raw.label : null,
    missing: Array.isArray(raw.missing) ? raw.missing.filter((m) => typeof m === 'string' && m) : [],
    providesMemberships: raw.provides_memberships !== false,
    canManage: raw.can_manage === true,
    reported: true,
  }
}

const CHOOSE_ON_WEB = 'Choose one on the web in Location settings → Integrations.'
const FINISH_ON_WEB = 'Finish setting it up on the web in Location settings → Integrations.'
const ASK_AN_OWNER = 'Ask an owner to connect a membership source.'

/**
 * The state card for a normalised source, or null when the numbers should
 * render (configured and providing memberships).
 *
 * @returns {null | { state: string, title: string, body: string }}
 */
export function membershipSourceCard(ms) {
  const s = ms && typeof ms.state === 'string' ? ms : NOT_REPORTED
  const label = s.label || (s.source && s.source !== 'unknown' && s.source !== 'none' ? s.source : 'The membership source')

  if (s.state === 'configured') {
    if (s.providesMemberships) return null
    return {
      state: 'configured',
      title: `${label} does not provide membership data`,
      body: `This view needs a membership source with membership data. ${s.canManage ? CHOOSE_ON_WEB : ASK_AN_OWNER}`,
    }
  }
  if (s.state === 'unconfigured') {
    const missing = s.missing.length ? s.missing.join(', ') : 'its credentials'
    return {
      state: 'unconfigured',
      title: `${label} is selected but not fully configured`,
      body: `Missing: ${missing}. ${s.canManage ? FINISH_ON_WEB : ASK_AN_OWNER}`,
    }
  }
  if (s.state === 'no_location') {
    return { state: 'no_location', title: 'Choose a location', body: 'Pick a studio to see its membership data.' }
  }
  if (s.state === 'none') {
    return {
      state: 'none',
      title: 'No membership source connected',
      body: `This studio has no membership source, so there is no membership data to show. ${s.canManage ? CHOOSE_ON_WEB : ASK_AN_OWNER}`,
    }
  }
  // unknown, and anything unrecognised: a retry, never "no source".
  return {
    state: 'unknown',
    title: 'Membership data could not be read right now',
    body: 'Pull down to try again. The membership source is not missing; it could not be checked.',
  }
}

/**
 * Business dashboard: the headline KPI row (Revenue MTD, Members, Churn
 * risk, In arrears) and the Membership section are Glofox-derived, so they
 * render only for a configured source. Otherwise ONE state card stands in
 * for both (the web gates the same two blocks, W1.M3a). The briefing line,
 * Needs you, funnel, ads and today strip are source-independent and always
 * render.
 *
 * @param {object} source  readMembershipSource()'s answer (fetchBusinessCommandCentre
 *                         attaches it as data.membershipSource)
 * @returns {{ showNumbers: boolean, card: null | { state, title, body } }}
 */
export function businessMembershipView(source) {
  const s = source && typeof source.state === 'string' ? source : NOT_REPORTED
  // An older server: render as before (see the header).
  if (!s.reported) return { showNumbers: true, card: null }
  const card = membershipSourceCard(s)
  return { showNumbers: card === null, card }
}

/**
 * Studio dashboard: the funnel counts are CONTACT counts and always render
 * (the web pipeline board is not gated either). Its later stages
 * (1st class … converted) move only on membership and booking data, so at
 * a studio whose source is not configured a note under the funnel says
 * why. null = no note (configured, an older server, or the contact numbers
 * themselves failed, which already has its own retry line).
 *
 * @param {object|null} contactCounts  /api/dashboard/studio-contacts data, or null
 * @returns {null | { state: string, text: string }}
 */
export function studioFunnelNote(contactCounts) {
  if (!contactCounts) return null
  const source = readMembershipSource(contactCounts.membership_source)
  if (!source.reported) return null
  const manage = source.canManage ? CHOOSE_ON_WEB : ASK_AN_OWNER
  switch (source.state) {
    case 'configured':
      return source.providesMemberships
        ? null
        : { state: 'configured', text: `${source.label || 'This membership source'} does not provide membership data, so stages after New will not move. ${manage}` }
    case 'none':
      return {
        state: 'none',
        text: `No membership source connected. Stages that depend on memberships and credits will not move; leads still enter and go dormant. ${manage}`,
      }
    case 'unconfigured': {
      const missing = source.missing.length ? source.missing.join(', ') : 'its credentials'
      return {
        state: 'unconfigured',
        text: `${source.label || 'The membership source'} is selected but not fully configured (missing: ${missing}), so stages that depend on memberships will not move. ${source.canManage ? FINISH_ON_WEB : ASK_AN_OWNER}`,
      }
    }
    case 'no_location':
      return null
    default:
      return {
        state: 'unknown',
        text: 'The membership source could not be checked right now. Pull down to try again.',
      }
  }
}
