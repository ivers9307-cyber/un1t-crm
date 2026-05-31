// RADAR-AGENT Phase 1 — account-answer tools for the customer agent.
//
// Lets the agent answer a member's OWN account questions — but only
// after the SERVER verifies their identity against the synced CRM
// contact. The model never decides who is verified: verify_identity
// does a real DB match and stamps the conversation; the lookup tools
// refuse unless that stamp is present and only read the verified
// contact.
//
// SCOPE NOTE (data reality, verified against prod): the Glofox sync
// carries membership STATE (active/paused/cancelled/future), an
// account-active flag, plan name (glofox_membership_plan, widely
// populated), and a full class-booking history in the `bookings` table
// (class_name, class_starts_at, attended, status — 48k+ rows). It does
// NOT carry price or a real payment-standing flag, so the agent hands
// off for "am I paid up / what did I pay". Everything else — status,
// plan, next class, recent attendance — it can answer after verifying.
//
// Pure helpers (identityMatches, formatMembership, formatNextClass,
// formatRecentAttendance) are unit-tested; the executor does the IO.

// ── Anthropic tool definitions ──────────────────────────────────────
export const ACCOUNT_TOOLS = [
  {
    name: 'verify_identity',
    description:
      "Verify the customer's identity before sharing any of their account details. " +
      'Call this when the customer asks about THEIR OWN account (membership status, plan, ' +
      'next class, recent attendance) and they have not been verified yet this ' +
      'conversation. Provide whatever identifying details the customer gives. Verification ' +
      'succeeds on a matching email on file, OR a matching date of birth together with a ' +
      'matching last name. If it fails, ask for the missing detail.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email the customer gives, matched against the email on their account.' },
        date_of_birth: { type: 'string', description: 'Date of birth in YYYY-MM-DD form.' },
        last_name: { type: 'string', description: 'Surname, used together with date of birth.' },
      },
    },
  },
  {
    name: 'get_my_membership',
    description:
      "Get the verified customer's current membership status (active, paused, cancelled) " +
      'and plan name if on file. Only works after verify_identity has succeeded this ' +
      'conversation. Use for "is my membership active", "is my account paused", "what plan ' +
      'am I on". Does NOT include price or payment/billing standing — hand off for those.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_my_next_class',
    description:
      "Get the verified customer's next upcoming booked class (name + date/time). Only " +
      'works after verify_identity has succeeded this conversation. Use for "when is my ' +
      'next class", "what have I got booked".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_my_recent_attendance',
    description:
      "Get a short summary of the verified customer's recent class attendance (how many " +
      'classes attended in the last 30 days, and when they last attended). Only works ' +
      'after verify_identity has succeeded. Use for "how many classes have I done", "when ' +
      'did I last come in".',
    input_schema: { type: 'object', properties: {} },
  },
]

export const ACCOUNT_TOOL_NAMES = new Set(ACCOUNT_TOOLS.map(t => t.name))

// ── pure helpers ────────────────────────────────────────────────────
export function normEmail(e) {
  return String(e || '').trim().toLowerCase()
}

function normDate(d) {
  if (!d) return ''
  const s = String(d).trim()
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  return m ? m[1] : ''
}

function normName(n) {
  return String(n || '').trim().toLowerCase()
}

/**
 * Does the provided identity evidence match this contact? Pure.
 * Passing rule: matching email on file, OR (matching DOB AND matching
 * last name). DOB or last name alone never passes.
 * @param {object|null} contact  { email, dob, last_name }
 * @param {object} provided      { email, date_of_birth, last_name }
 */
export function identityMatches(contact, provided) {
  if (!contact || !provided) return false
  const pe = normEmail(provided.email)
  if (pe && normEmail(contact.email) && pe === normEmail(contact.email)) return true

  const pdob = normDate(provided.date_of_birth)
  const cdob = normDate(contact.dob)
  const pln = normName(provided.last_name)
  const cln = normName(contact.last_name)
  if (pdob && cdob && pdob === cdob && pln && cln && pln === cln) return true

  return false
}

/**
 * Human-friendly membership summary for the agent to relay. Pure.
 * Reads the reliably-synced Glofox columns: state + account-active +
 * plan (when present). Price/payment standing are not reported here.
 */
export function formatMembership(contact) {
  if (!contact) return { found: false }
  const state = contact.glofox_membership_state || null
  const acctActive = contact.glofox_account_active
  if (!state && acctActive == null) return { found: false }

  const stateLabels = {
    active: 'active',
    paused: 'paused',
    cancelled: 'cancelled',
    future: 'starting soon (not active yet)',
    inactive: 'not currently active',
  }
  let status
  if (state && stateLabels[state]) status = stateLabels[state]
  else if (state) status = state
  else status = acctActive ? 'active' : 'not currently active'

  const out = {
    found: true,
    status,
    raw_state: state,
    account_active: acctActive == null ? null : !!acctActive,
  }
  const plan = contact.glofox_membership_plan_full || contact.glofox_membership_plan || null
  if (plan) out.plan = plan
  return out
}

/** Format the next upcoming class from booking rows. Pure. now injectable for tests. */
export function formatNextClass(bookings, now = new Date()) {
  const upcoming = (bookings || [])
    .filter(b => b && b.class_starts_at && new Date(b.class_starts_at) > now && b.status !== 'cancelled')
    .sort((a, b) => new Date(a.class_starts_at) - new Date(b.class_starts_at))
  if (upcoming.length === 0) return { found: false }
  const next = upcoming[0]
  return { found: true, class_name: next.class_name || 'your class', class_time: next.class_starts_at }
}

/**
 * Summarise recent attendance from booking rows. Pure. Counts classes
 * marked attended in the trailing `days` window and the most recent
 * attended date. now injectable for tests.
 */
export function formatRecentAttendance(bookings, now = new Date(), days = 30) {
  const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const attended = (bookings || [])
    .filter(b => b && b.attended === true && b.class_starts_at && new Date(b.class_starts_at) <= now)
    .sort((a, b) => new Date(b.class_starts_at) - new Date(a.class_starts_at))
  const inWindow = attended.filter(b => new Date(b.class_starts_at) >= windowStart)
  return {
    found: attended.length > 0,
    attended_last_30d: inWindow.length,
    last_attended: attended.length > 0 ? attended[0].class_starts_at : null,
    window_days: days,
  }
}

// ── executor (IO) ───────────────────────────────────────────────────
// ctx: { db, conversationId, conversationsTable, contactId, verifiedContactId, locationId }
export async function executeAccountTool(toolName, input, ctx) {
  const { db, conversationId, conversationsTable, contactId, verifiedContactId, locationId } = ctx

  if (toolName === 'verify_identity') {
    let candidate = null
    if (contactId) {
      const { data } = await db.from('contacts')
        .select('id, email, dob, last_name')
        .eq('id', contactId)
        .maybeSingle()
      candidate = data || null
    } else if (normEmail(input?.email)) {
      const { data } = await db.from('contacts')
        .select('id, email, dob, last_name')
        .eq('location_id', locationId)
        .ilike('email', normEmail(input.email))
        .limit(1)
        .maybeSingle()
      candidate = data || null
    }

    if (!candidate || !identityMatches(candidate, input || {})) {
      return { verified: false, hint: 'No match. Ask for the email on their account, or their date of birth together with their surname.' }
    }

    await db.from(conversationsTable).update({
      agent_verified_contact_id: candidate.id,
      agent_verified_at: new Date().toISOString(),
    }).eq('id', conversationId)
    return { verified: true }
  }

  const verifiedId = verifiedContactId
  if (!verifiedId) {
    return { error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first.' }
  }

  if (toolName === 'get_my_membership') {
    const { data } = await db.from('contacts')
      .select('glofox_membership_state, glofox_account_active, glofox_membership_plan, glofox_membership_plan_full')
      .eq('id', verifiedId)
      .maybeSingle()
    return formatMembership(data)
  }

  if (toolName === 'get_my_next_class') {
    const { data } = await db.from('bookings')
      .select('class_name, class_starts_at, status, attended')
      .eq('contact_id', verifiedId)
      .eq('booking_type', 'class')
      .gte('class_starts_at', new Date().toISOString())
      .order('class_starts_at', { ascending: true })
      .limit(10)
    return formatNextClass(data)
  }

  if (toolName === 'get_my_recent_attendance') {
    const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()
    const { data } = await db.from('bookings')
      .select('class_starts_at, attended, status')
      .eq('contact_id', verifiedId)
      .eq('booking_type', 'class')
      .gte('class_starts_at', since)
      .order('class_starts_at', { ascending: false })
      .limit(100)
    return formatRecentAttendance(data)
  }

  return { error: 'unknown_tool', tool: toolName }
}
