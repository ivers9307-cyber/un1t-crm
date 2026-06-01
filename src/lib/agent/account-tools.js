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
// denormalises class data onto the CONTACTS row (not a bookings table):
//   - glofox_membership_state / glofox_account_active / glofox_membership_plan
//   - last_attended_at, total_attended_30d, total_attended_7d (rollups)
//   - recent_bookings (jsonb array; each {event_name, model_name,
//     time_start unix-sec, attended, status, duration})
// This is the exact source the contact profile's GLOFOX MEMBERSHIP card
// renders. It does NOT carry price or a payment-standing flag, so the
// agent hands off for "am I paid up / what did I pay". Everything else —
// status, plan, next class, recent attendance — it answers after verifying.
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
      'needs a matching email together with the surname on the account, OR a matching date ' +
      'of birth together with the surname. A matching email on its own is NOT enough. If it ' +
      'fails, ask for the missing detail — usually the surname.',
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
      "Get the verified customer's current membership status (active, paused, cancelled), " +
      'their plan name, and (when the plan is in the studio catalog) a short description ' +
      'of what the plan includes — its pricing and commitment terms. Only works after ' +
      'verify_identity has succeeded this conversation. Use for "is my membership active", ' +
      '"what plan am I on", "what does my plan include". For live billing standing or ' +
      'payment issues, hand off.',
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
  {
    name: 'request_pause',
    description:
      "Log a request to PAUSE the verified customer's membership for a human to approve. " +
      'Only after verify_identity has succeeded. Gather what you can first: when they want ' +
      'the pause to start and end (or how long), and the reason. You are NOT pausing it ' +
      'yourself — this queues the request for the team. Tell the customer it has been ' +
      'requested and the team will confirm; never say it is done.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Requested pause start, YYYY-MM-DD if given.' },
        end_date: { type: 'string', description: 'Requested pause end / return date, YYYY-MM-DD if given.' },
        reason: { type: 'string', description: "The customer's reason for pausing, in their words." },
      },
    },
  },
  {
    name: 'request_cancellation',
    description:
      "Log a request to CANCEL the verified customer's membership for a human to approve. " +
      'Only after verify_identity has succeeded. Per the studio flow, the assistant first ' +
      'offers a pause as an alternative ONCE; call this tool when the customer still wants ' +
      'to cancel (or declines the pause). Gather the reason and any desired cancellation ' +
      'date. You are NOT cancelling it yourself — capture the request and queue it; the team ' +
      'handles any further retention. Tell the customer it has been requested and the team ' +
      'will be in touch; never say it is done.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: "The customer's reason for cancelling, in their words." },
        desired_date: { type: 'string', description: 'Requested cancellation date, YYYY-MM-DD if given.' },
      },
    },
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
 * Does `surname` appear as a whole word in a free-text display name? Pure.
 * Whitespace-tokenised, then each token is stripped of non-alphanumerics
 * so "O'Brien" / "Smith-Jones" match a stored surname of the same.
 * Substring matches are deliberately NOT accepted (no "Lee" inside
 * "Ashlee"). Surnames under 2 chars never match.
 */
export function surnameInName(fullName, surname) {
  const strip = s => normName(s).replace(/[^a-z0-9]/g, '')
  const sd = strip(surname)
  if (sd.length < 2) return false
  const tokens = String(fullName || '').trim().split(/\s+/).filter(Boolean)
  return tokens.some(t => strip(t) === sd)
}

/**
 * Identity check for the EMAIL path — the unlinked-conversation case
 * (Instagram always; WhatsApp only when the number isn't on a contact).
 * Email alone is too weak here (emails aren't secret), so we additionally
 * require the surname. The surname is satisfied either by what the
 * customer supplies OR by their channel display name (nameHint) already
 * showing it — so an Instagram member whose handle/name is "Jane Murphy"
 * isn't made to retype "Murphy". Pure.
 *
 * @param {object|null} contact   { email, last_name }
 * @param {object} provided       { email, last_name }
 * @param {object} [opts]         { nameHint } channel display name
 */
export function emailPathVerifies(contact, provided, opts = {}) {
  if (!contact || !provided) return false
  const pe = normEmail(provided.email)
  const ce = normEmail(contact.email)
  if (!pe || !ce || pe !== ce) return false          // email must match
  const cln = normName(contact.last_name)
  if (!cln) return false                             // no surname on file → can't satisfy the 2nd factor
  if (normName(provided.last_name) === cln) return true   // customer supplied the surname
  return surnameInName(opts.nameHint, contact.last_name)  // surname evident from their channel name
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
  // plan_details = pricing + commitment terms from the studio catalog,
  // resolved by the caller (executor) and attached as membership_description.
  if (contact.membership_description) out.plan_details = contact.membership_description
  return out
}

/**
 * Format the next upcoming class from the contact's recent_bookings jsonb
 * array (each row: { event_name, model_name, time_start unix-sec, status }).
 * Pure. now injectable for tests.
 */
export function formatNextClass(recentBookings, now = new Date()) {
  const nowSec = Math.floor(now.getTime() / 1000)
  const upcoming = (recentBookings || [])
    .filter(b => b && Number(b.time_start) > nowSec && String(b.status || '').toUpperCase() !== 'CANCELLED')
    .sort((a, b) => Number(a.time_start) - Number(b.time_start))
  if (upcoming.length === 0) return { found: false }
  const next = upcoming[0]
  return {
    found: true,
    class_name: next.event_name || next.model_name || 'your class',
    class_time: new Date(Number(next.time_start) * 1000).toISOString(),
  }
}

/**
 * Summarise recent attendance from the contact's synced rollup columns
 * (total_attended_30d, total_attended_7d, last_attended_at). Pure.
 */
export function formatRecentAttendance(contact) {
  if (!contact) return { found: false }
  const a30 = Number(contact.total_attended_30d) || 0
  const a7 = Number(contact.total_attended_7d) || 0
  const last = contact.last_attended_at || null
  if (!a30 && !a7 && !last) return { found: false }
  return { found: true, attended_last_30d: a30, attended_last_7d: a7, last_attended: last }
}

// ── pure request builders ───────────────────────────────────────────
function cleanDate(d) {
  if (!d) return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(d).trim())
  return m ? m[1] : null
}
function cleanText(t, max = 1000) {
  if (typeof t !== 'string') return null
  const s = t.trim()
  if (!s) return null
  return s.length > max ? s.slice(0, max) : s
}

/** Build the details jsonb for a pause request. Pure. */
export function buildPauseDetails(input = {}) {
  return {
    start_date: cleanDate(input.start_date),
    end_date: cleanDate(input.end_date),
    reason: cleanText(input.reason),
  }
}

/** Build the details jsonb for a cancellation request. Pure. */
export function buildCancellationDetails(input = {}) {
  return {
    reason: cleanText(input.reason),
    desired_date: cleanDate(input.desired_date),
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

    // Linked conversations (a phone-matched WhatsApp contact) keep the
    // email-OR-DOB+surname rule — the channel is already a weak factor.
    // Unlinked conversations (Instagram always; unknown WhatsApp numbers)
    // go through the email PATH, which requires email + surname so that
    // knowing only an email can't impersonate a member. The surname may
    // come from the channel display name (nameHint).
    const matched = contactId
      ? identityMatches(candidate, input || {})
      : emailPathVerifies(candidate, input || {}, { nameHint: ctx.nameHint })
    if (!candidate || !matched) {
      return { verified: false, hint: 'No match yet. Ask for the surname on the account together with the email, or their date of birth together with their surname. Never reveal which detail did or did not match.' }
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
    // Resolve the plan's description (pricing + commitment terms) from the
    // studio membership catalog by plan name — same lookup the contact
    // profile uses. Current-catalog plans resolve; archived/promo plans
    // Glofox no longer returns just fall back to the plan name.
    if (data?.glofox_membership_plan && locationId) {
      const { data: catalogRows } = await db.from('glofox_memberships')
        .select('name_clean, plan_names, description')
        .eq('location_id', locationId)
      // Lazy import: glofox-catalog statically pulls @/lib/supabase (and
      // thus next), which isn't available in the unit-test env. Importing
      // here keeps account-tools.js test-loadable while reusing the shared
      // matcher in the server runtime.
      const { matchCatalogToPlan } = await import('@/lib/glofox-catalog')
      const catMatch = matchCatalogToPlan(catalogRows || [], {
        plan: data.glofox_membership_plan,
        planFull: data.glofox_membership_plan_full,
      })
      if (catMatch?.description) data.membership_description = catMatch.description
    }
    return formatMembership(data)
  }

  if (toolName === 'get_my_next_class') {
    const { data } = await db.from('contacts')
      .select('recent_bookings')
      .eq('id', verifiedId)
      .maybeSingle()
    return formatNextClass(data?.recent_bookings)
  }

  if (toolName === 'get_my_recent_attendance') {
    const { data } = await db.from('contacts')
      .select('total_attended_30d, total_attended_7d, last_attended_at')
      .eq('id', verifiedId)
      .maybeSingle()
    return formatRecentAttendance(data)
  }

  if (toolName === 'request_pause' || toolName === 'request_cancellation') {
    const kind = toolName === 'request_pause' ? 'pause' : 'cancellation'
    const details = kind === 'pause' ? buildPauseDetails(input) : buildCancellationDetails(input)
    const { error } = await db.from('agent_membership_requests').insert({
      location_id: locationId,
      contact_id: verifiedId,
      kind,
      channel: ctx.channel || null,
      conversation_id: conversationId || null,
      details,
      customer_note: details.reason || null,
      status: 'pending',
      // Cancellations are flagged for a retention attempt by default so a
      // human can try a save before it's actioned.
      retention_flagged: kind === 'cancellation',
    })
    if (error) return { error: 'queue_failed', message: error.message }
    return { requested: true, kind }
  }

  return { error: 'unknown_tool', tool: toolName }
}
