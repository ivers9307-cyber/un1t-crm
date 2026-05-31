// RADAR-AGENT Phase 1 — account-answer tools for the customer agent.
//
// Lets the agent confirm a member's OWN membership status — but only
// after the SERVER verifies their identity against the synced CRM
// contact. The model never decides who is verified: verify_identity
// does a real DB match and stamps the conversation; get_my_membership
// refuses unless that stamp is present and only reads the verified
// contact.
//
// SCOPE NOTE (data reality): the CRM's Glofox sync reliably carries
// membership STATE (active / paused / cancelled / future) and an
// account-active flag, but NOT plan name, price, payment standing, or
// class bookings (those columns are effectively empty, and the
// bookings table holds race/event entries, not Glofox classes). So the
// agent can answer "is my membership active/paused" — and hands off for
// "what plan / am I paid up / when's my next class". Expanding those
// needs a Glofox sync expansion or a live read (a later phase).
//
// Pure helpers (identityMatches, formatMembership) are unit-tested;
// the executor does the IO.

// ── Anthropic tool definitions ──────────────────────────────────────
export const ACCOUNT_TOOLS = [
  {
    name: 'verify_identity',
    description:
      "Verify the customer's identity before sharing any of their account details. " +
      'Call this when the customer asks about THEIR OWN membership (e.g. "is my membership ' +
      'active", "is my account paused") and they have not been verified yet this ' +
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
      "Get the verified customer's current membership status (active, paused, cancelled). " +
      'Only works after verify_identity has succeeded this conversation. Use for ' +
      '"is my membership active", "is my account paused". This returns STATUS ONLY — it ' +
      'does NOT include the plan name, price, payment standing, or class bookings; for ' +
      'those, hand off to a human.',
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
 * Reads only the reliably-synced Glofox columns: state + account-active.
 * Plan name is included ONLY if present (it almost never is); price,
 * payment standing and bookings are deliberately not reported here.
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
  // Derive a friendly status: prefer the explicit state; fall back to
  // the account-active flag when state is absent.
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
  // Only surface a plan name if one actually exists on the record.
  const plan = contact.glofox_membership_plan_full || contact.glofox_membership_plan || null
  if (plan) out.plan = plan
  return out
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

  return { error: 'unknown_tool', tool: toolName }
}
