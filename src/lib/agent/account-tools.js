// RADAR-AGENT Phase 1 — account-answer tools for the customer agent.
//
// Lets the agent answer a member's OWN account questions (membership
// status, plan, next class) — but only after the SERVER verifies their
// identity against the synced CRM contact. The model never decides who
// is verified: verify_identity does a real DB match and stamps the
// conversation; the lookup tools refuse unless that stamp is present.
//
// Data is read from the CRM's Glofox-synced columns (contacts.*,
// bookings.*) — no live Glofox call. All reads are scoped to the
// verified contact only.
//
// Pure helpers (identityMatches, formatters) are unit-tested; the
// executor does the IO.

// ── Anthropic tool definitions ──────────────────────────────────────
export const ACCOUNT_TOOLS = [
  {
    name: 'verify_identity',
    description:
      "Verify the customer's identity before sharing any of their account details. " +
      'Call this when the customer asks about THEIR OWN account (membership status, ' +
      'their plan, whether they are paid up, their next class) and they have not been ' +
      'verified yet this conversation. Provide whatever identifying details the customer ' +
      'gives. Verification succeeds on a matching email on file, OR a matching date of ' +
      'birth together with a matching last name. If it fails, ask for the missing detail.',
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
      "Get the verified customer's current membership status, plan name and price. " +
      'Only works after verify_identity has succeeded this conversation. Use for ' +
      '"what plan am I on", "am I paid up", "is my membership active/paused".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_my_next_class',
    description:
      "Get the verified customer's next upcoming booked class. Only works after " +
      'verify_identity has succeeded this conversation. Use for "when is my next class", ' +
      '"what have I got booked".',
    input_schema: { type: 'object', properties: {} },
  },
]

export const ACCOUNT_TOOL_NAMES = new Set(ACCOUNT_TOOLS.map(t => t.name))

// ── pure helpers ────────────────────────────────────────────────────
export function normEmail(e) {
  return String(e || '').trim().toLowerCase()
}

function normDate(d) {
  // Accept Date, ISO string, or YYYY-MM-DD; compare on the date part only.
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
 * @param {object|null} contact  { email, birthday, last_name }
 * @param {object} provided      { email, date_of_birth, last_name }
 */
export function identityMatches(contact, provided) {
  if (!contact || !provided) return false
  const pe = normEmail(provided.email)
  if (pe && normEmail(contact.email) && pe === normEmail(contact.email)) return true

  const pdob = normDate(provided.date_of_birth)
  const cdob = normDate(contact.birthday)
  const pln = normName(provided.last_name)
  const cln = normName(contact.last_name)
  if (pdob && cdob && pdob === cdob && pln && cln && pln === cln) return true

  return false
}

/** Human-friendly membership summary for the agent to relay. Pure. */
export function formatMembership(contact) {
  if (!contact) return { found: false }
  const stateLabels = {
    member: 'active',
    paused: 'paused',
    cancelled: 'cancelled',
    former_member: 'no longer active',
    non_member: 'not currently a member',
  }
  return {
    found: true,
    status: stateLabels[contact.membership_state] || contact.membership_state || 'unknown',
    raw_state: contact.membership_state || null,
    plan: contact.membership_plan_name_full || contact.membership_plan_name || null,
    price: contact.membership_plan_price || null,
  }
}

/** Format the next upcoming class row. Pure. now is injectable for tests. */
export function formatNextClass(bookings, now = new Date()) {
  const upcoming = (bookings || [])
    .filter(b => b && b.class_time && new Date(b.class_time) > now && b.status !== 'cancelled')
    .sort((a, b) => new Date(a.class_time) - new Date(b.class_time))
  if (upcoming.length === 0) return { found: false }
  const next = upcoming[0]
  return {
    found: true,
    class_name: next.class_name || 'your class',
    class_time: next.class_time,
  }
}

// ── executor (IO) ───────────────────────────────────────────────────
// ctx: { db, conversationId, conversationsTable, contactId, verifiedContactId, locationId }
export async function executeAccountTool(toolName, input, ctx) {
  const { db, conversationId, conversationsTable, contactId, verifiedContactId, locationId } = ctx

  if (toolName === 'verify_identity') {
    // Candidate contact: the one already linked to the conversation, else
    // resolve by the email provided (scoped to this location).
    let candidate = null
    if (contactId) {
      const { data } = await db.from('contacts')
        .select('id, email, birthday, last_name')
        .eq('id', contactId)
        .maybeSingle()
      candidate = data || null
    } else if (normEmail(input?.email)) {
      const { data } = await db.from('contacts')
        .select('id, email, birthday, last_name')
        .eq('location_id', locationId)
        .ilike('email', normEmail(input.email))
        .limit(1)
        .maybeSingle()
      candidate = data || null
    }

    if (!candidate || !identityMatches(candidate, input || {})) {
      return { verified: false, hint: 'No match. Ask for the email on their account, or their date of birth together with their surname.' }
    }

    // Stamp the conversation as verified (server-trusted).
    await db.from(conversationsTable).update({
      agent_verified_contact_id: candidate.id,
      agent_verified_at: new Date().toISOString(),
    }).eq('id', conversationId)
    return { verified: true }
  }

  // All other account tools require an established verification.
  const verifiedId = verifiedContactId
  if (!verifiedId) {
    return { error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first.' }
  }

  if (toolName === 'get_my_membership') {
    const { data } = await db.from('contacts')
      .select('membership_state, membership_plan_name, membership_plan_name_full, membership_plan_price')
      .eq('id', verifiedId)
      .maybeSingle()
    return formatMembership(data)
  }

  if (toolName === 'get_my_next_class') {
    const { data } = await db.from('bookings')
      .select('class_name, class_time, status')
      .eq('contact_id', verifiedId)
      .gte('class_time', new Date().toISOString())
      .order('class_time', { ascending: true })
      .limit(10)
    return formatNextClass(data)
  }

  return { error: 'unknown_tool', tool: toolName }
}
