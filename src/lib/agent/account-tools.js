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

import { formatDublinClassTime } from './dublin-format'
import { escapeLikePattern } from '../like-escape'
import { linkedAccountsForContact, hasBookableMembership, electWriteAccount } from '@/lib/person-accounts'

// ── Anthropic tool definitions ──────────────────────────────────────
export const ACCOUNT_TOOLS = [
  {
    name: 'verify_identity',
    description:
      "Verify the customer's identity before sharing any of their account details. " +
      'Call this when the customer asks about THEIR OWN account (membership status, plan, ' +
      'next class, recent attendance) and they have not been verified yet this ' +
      'conversation. Provide whatever identifying details the customer gives. Verification ' +
      'uses the email on their account, plus their surname on channels the studio cannot ' +
      'already tie to an account. NEVER ask for a date of birth — the studio does not hold ' +
      'one. If it fails, ask for exactly what the returned hint says and nothing more.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email the customer gives, matched against the email on their account.' },
        last_name: { type: 'string', description: 'Surname, matched against the account.' },
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
  {
    name: 'request_membership_purchase',
    description:
      'Log that this customer wants to BUY or START a membership / accept a membership offer ' +
      '(e.g. they replied "yes" to a studio offer message, or asked to join). No verification ' +
      'needed — this queues the request for the team, who set up the membership and billing ' +
      'and confirm with the customer. Capture which offer or plan they mean (quote the studio ' +
      "message they're replying to if that's what named it). Tell the customer the team will " +
      'set it up and confirm shortly — never say it is done, and never quote a price that ' +
      "isn't in KNOWLEDGE or the offer message.",
    input_schema: {
      type: 'object',
      properties: {
        offer: { type: 'string', description: 'The offer or plan they accepted, as named in the studio message or by the customer (e.g. "Kickstarter — first month €99").' },
        note: { type: 'string', description: 'Anything else useful for the team, in the customer\'s words.' },
      },
    },
  },
]

export const ACCOUNT_TOOL_NAMES = new Set(ACCOUNT_TOOLS.map(t => t.name))

// ── pure helpers ────────────────────────────────────────────────────
export function normEmail(e) {
  return String(e || '').trim().toLowerCase()
}

function normName(n) {
  return String(n || '').trim().toLowerCase()
}

/**
 * Does the provided identity evidence match this contact? Pure.
 * Used for LINKED conversations only (the sender's number is already
 * on the contact, so the channel is a factor): a matching email on
 * file passes. DOB was removed 2026-06-12 — the studio doesn't gather
 * dates of birth, so that branch could never match and only made the
 * agent ask customers for something useless.
 * @param {object|null} contact  { email }
 * @param {object} provided      { email }
 */
export function identityMatches(contact, provided) {
  if (!contact || !provided) return false
  const pe = normEmail(provided.email)
  return !!(pe && normEmail(contact.email) && pe === normEmail(contact.email))
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
 * From the pool of contacts that belong to THIS sender, pick the one a
 * verification attempt matches — or null. Pure.
 *
 * LINKED (`linked:true` — a WhatsApp thread whose number is already on a
 * contact): a matching email on ANY of the sender's contacts verifies, because
 * the number is the second factor. We test the whole pool — every contact on
 * the sender's number — NOT just the thread's bound contact_id, so a thread
 * pinned to a duplicate whose email differs from the member's can still verify.
 * The customer can only ever type their own real email, never the dupe's, so
 * this doesn't weaken the check; it just stops it being unwinnable.
 *
 * UNLINKED (`linked:false` — Instagram, or an unknown WhatsApp number): email
 * alone is too weak, so emailPathVerifies additionally requires the surname
 * (supplied, or evident from the channel display name `nameHint`).
 *
 * @param {Array<object>|null} candidates  contacts on the sender's number/person
 * @param {object} provided                { email, last_name }
 * @param {object} [opts]                   { linked, nameHint }
 * @returns {object|null} the matched contact
 */
/**
 * The retry hint for a failed verify_identity. Context-aware, because the two
 * paths need different things: on the LINKED path the number is the second
 * factor and email alone verifies (and when the number carries more than one
 * account the prompt mandates asking for the email ONLY), so asking for a
 * surname there contradicts the flow and confuses the customer — the surname is
 * only genuinely required on the UNLINKED path (Instagram / unknown number).
 * Never reveals which detail did or did not match. Pure.
 * @param {boolean} linked  the sender's number/handle is already on a contact
 */
export function verifyFailureHint(linked) {
  return linked
    ? 'No match yet. Ask them to double-check the email on the account and send it again. Do NOT ask for a surname on this path. Never reveal which detail did or did not match.'
    : 'No match yet. Ask for the email on the account together with the surname. Never ask for a date of birth. Never reveal which detail did or did not match.'
}

export function pickVerifiedContact(candidates, provided, { linked = false, nameHint = null } = {}) {
  const pool = Array.isArray(candidates) ? candidates.filter(Boolean) : []
  const test = linked
    ? (c) => identityMatches(c, provided || {})
    : (c) => emailPathVerifies(c, provided || {}, { nameHint })
  return pool.find(test) || null
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
 *
 * class_time is a DUBLIN WALL-CLOCK label ("Sat 13 Jun, 07:00"), never a raw
 * UTC ISO string: handing the model UTC is what told a customer their 7am
 * summer class was at "6am" (live test 2026-06-12, fixed for the booking
 * tools then and for this one in MIA-REVIEW.3). Same helper both sides.
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
    class_time: formatDublinClassTime(Number(next.time_start)),
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

// PERSON-ACCT.3 — a person's membership/attendance can live on ANY of
// their linked contact rows, not just the one a conversation happens to
// be attached to. These three pure helpers pick/merge across the group
// (linkedAccountsForContact's `contacts` array); the executor supplies
// the rows and reads no further than what it already reads for a single
// contact.

/**
 * Pick the row whose membership best represents the person, across every
 * contact row in their person group. Pure. Pick order:
 *   1. a row with a genuinely bookable membership (hasBookableMembership —
 *      MEMBER_STATUSES status whose state hasn't ended; NOT the same as
 *      glofox_membership_status === 'active', which never occurs — see
 *      person-accounts.js)
 *   2. a row with glofox_membership_status === 'trial' AND
 *      trial_credits_remaining > 0
 *   3. otherwise the row with the most recent updated_at
 * Returns null for an empty/absent pool.
 */
export function pickBestMembershipContact(contacts) {
  const rows = Array.isArray(contacts) ? contacts.filter(Boolean) : []
  if (rows.length === 0) return null
  const bookable = rows.find((c) => hasBookableMembership(c))
  if (bookable) return bookable
  const trialWithCredits = rows.find(
    (c) => c.glofox_membership_status === 'trial' && Number(c.trial_credits_remaining) > 0,
  )
  if (trialWithCredits) return trialWithCredits
  return rows.reduce((best, c) => {
    if (!best) return c
    return new Date(c.updated_at || 0) > new Date(best.updated_at || 0) ? c : best
  }, null)
}

/**
 * True when 2+ rows in the group each carry a genuinely bookable membership
 * (hasBookableMembership) — worth a note for staff to look at, even though
 * the model still answers from whichever single row
 * pickBestMembershipContact chose. A ClassPass PAYG account never trips
 * this: its status is 'classpass_payg', which isn't in MEMBER_STATUSES,
 * however live its glofox_membership_state might read.
 */
export function hasDoubleMembership(contacts) {
  const rows = Array.isArray(contacts) ? contacts.filter(Boolean) : []
  const bookableRows = rows.filter((c) => hasBookableMembership(c))
  return bookableRows.length >= 2
}

/**
 * Merge per-contact attendance rollups across the person group into one
 * pseudo-row of the same shape formatRecentAttendance already reads:
 * counts SUM across accounts, last_attended is the MOST RECENT across
 * accounts. Pure.
 */
export function mergeRecentAttendanceRows(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : []
  let attended30 = 0
  let attended7 = 0
  let last = null
  for (const r of list) {
    attended30 += Number(r.total_attended_30d) || 0
    attended7 += Number(r.total_attended_7d) || 0
    if (r.last_attended_at && (!last || new Date(r.last_attended_at) > new Date(last))) {
      last = r.last_attended_at
    }
  }
  return { total_attended_30d: attended30, total_attended_7d: attended7, last_attended_at: last }
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

/** Build the details jsonb for a membership-purchase request. Pure. */
export function buildMembershipPurchaseDetails(input = {}) {
  return {
    offer: cleanText(input.offer, 300),
    note: cleanText(input.note),
  }
}

// All contacts belonging to the sender behind a LINKED conversation: every
// contact that shares the bound contact's WhatsApp/phone number at this
// location (duplicates included), so verify_identity can match the member's
// real email even when the thread is pinned to a duplicate whose email differs.
// Falls back to just the bound contact when it carries no number. Mirrors the
// phone match auto-reply uses for phone auto-verify (core.resolveAutoVerify).
async function contactsForSender(db, { contactId, locationId }) {
  const { data: bound } = await db.from('contacts')
    .select('id, email, last_name, wa_phone, phone')
    .eq('id', contactId)
    .maybeSingle()
  if (!bound) return []
  const bares = [...new Set([bound.wa_phone, bound.phone]
    .filter(Boolean)
    .map((n) => String(n).replace(/^\+/, '')))]
  if (bares.length === 0) return [bound]
  const ors = bares
    .flatMap((b) => [`wa_phone.eq.${b}`, `wa_phone.eq.+${b}`, `phone.eq.${b}`, `phone.eq.+${b}`])
    .join(',')
  const { data: siblings } = await db.from('contacts')
    .select('id, email, last_name')
    .eq('location_id', locationId)
    .or(ors)
    .limit(20)
  const pool = (siblings && siblings.length) ? siblings : [bound]
  // Guarantee the bound contact is present even if the phone query missed it.
  if (!pool.some((c) => c.id === bound.id)) {
    pool.push({ id: bound.id, email: bound.email, last_name: bound.last_name })
  }
  return pool
}

// Re-exported for the callers (and tests) that already import it from here.
// The definition moved to src/lib/like-escape.js on 2026-08-07 once the same
// class of bug turned up in the inbound-email webhook and five other lookups —
// this was the first place it was found, not the only place it applies.
export { escapeLikePattern }

// Contacts at this location whose email the customer just supplied. Escaped
// pattern + a small pool (not .limit(1)) so a wildcard-ish input can never
// silently decide WHICH row gets tested — pickVerifiedContact does the exact
// matching over whatever comes back.
async function contactsByEmail(db, locationId, email) {
  const { data } = await db.from('contacts')
    .select('id, email, last_name')
    .eq('location_id', locationId)
    .ilike('email', escapeLikePattern(email))
    .limit(5)
  return data || []
}

// PERSON-ACCT.3 — chunk any .in() call at <=150 ids (house rule / PostREST
// URL-length limit). Person groups are 2-6 rows in practice, so this loop
// almost always runs once; the cap is house law regardless.
const ID_CHUNK_SIZE = 150
function chunkIds(ids, size = ID_CHUNK_SIZE) {
  const out = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

// Fetch `columns` for every id in `ids`, chunked. Throws on the first
// Postgrest error so the caller's try/catch can fall back to the
// single-contact read — an unreadable group must never present as an
// empty/wrong answer.
async function fetchContactRowsByIds(db, ids, columns) {
  const rows = []
  for (const batch of chunkIds(ids)) {
    const { data, error } = await db.from('contacts').select(columns).in('id', batch)
    if (error) throw error
    rows.push(...(data || []))
  }
  return rows
}

// Tool results are written FOR the model (the card-tools convention): a raw
// PostgREST/Postgres string would put constraint, column and RLS detail into
// the model's context, and the model has been known to paraphrase what it
// sees. Clean message to the model, real error to the server log.
function queueFailed(kind, error) {
  console.error(`[agent][account] ${kind} request insert failed: ${error?.message || error}`)
  return {
    error: 'queue_failed',
    message: 'The request could not be queued. Apologise briefly and hand off to the team.',
  }
}

// ── executor (IO) ───────────────────────────────────────────────────
// ctx: { db, conversationId, conversationsTable, contactId, verifiedContactId, locationId, channel }
export async function executeAccountTool(toolName, input, ctx) {
  const { db, conversationId, conversationsTable, contactId, verifiedContactId, locationId } = ctx

  if (toolName === 'verify_identity') {
    // AGENT-AUTH — what "linked" actually means: the sender's PHONE NUMBER is
    // already on a contact, so the channel itself is the second factor and an
    // email match alone verifies. That is a WhatsApp property, not a
    // contact_id property: instagram_conversations also carries a contact_id
    // (nothing writes it today, but the column and the read path exist), and
    // keying on !!contactId would silently downgrade any future IG contact
    // link from email+surname to email-only. Emails are not secret, so the
    // predicate is the phone factor, not the link.
    const linked = ctx.channel === 'whatsapp' && !!contactId

    // Candidate pool = the contacts belonging to THIS sender.
    // Linked → EVERY contact sharing the sender's number at this location, so
    // a thread pinned to a duplicate whose email differs from the member's can
    // still verify (the linked-path check used to look at the bound contact_id
    // alone, which made the quiz unwinnable for members with duplicate contact
    // rows on one number).
    // Unlinked (Instagram / unknown number) → the contacts whose email the
    // customer supplies (email + surname required, see pickVerifiedContact),
    // plus any contact bound to the thread.
    const emailInput = normEmail(input?.email)
    let candidates = contactId ? await contactsForSender(db, { contactId, locationId }) : []
    if (!linked && emailInput) {
      candidates = [...candidates, ...(await contactsByEmail(db, locationId, emailInput))]
    }

    const matchedContact = pickVerifiedContact(candidates, input || {}, {
      linked,
      nameHint: ctx.nameHint,
    })
    if (!matchedContact) {
      return { verified: false, hint: verifyFailureHint(linked) }
    }

    // Stamp the matched contact. PERSON-ACCT.6 — auto-reply acts on this id AS
    // STAMPED, on this and subsequent turns: it is the person's anchor, and
    // reads span the whole person group from it (person-accounts.js). It used
    // to be remapped to the group's DISPLAY primary, which routinely holds none
    // of the person's activity.
    await db.from(conversationsTable).update({
      agent_verified_contact_id: matchedContact.id,
      agent_verified_at: new Date().toISOString(),
    }).eq('id', conversationId)
    return { verified: true }
  }

  // Deliberately unverified — a lead accepting a sales offer has no account
  // to protect yet, and demanding the email+surname quiz mid-"yes" kills the
  // sale. The team verifies who they are when they action the request.
  if (toolName === 'request_membership_purchase') {
    const targetContactId = verifiedContactId || contactId || null
    if (!targetContactId) {
      return { error: 'no_contact', message: 'No contact linked to this conversation — hand off to the team instead.' }
    }
    const details = buildMembershipPurchaseDetails(input)
    const { data: inserted, error } = await db.from('agent_membership_requests').insert({
      location_id: locationId,
      contact_id: targetContactId,
      kind: 'membership_purchase',
      channel: ctx.channel || null,
      conversation_id: conversationId || null,
      details,
      customer_note: details.note || details.offer || null,
      status: 'pending',
    }).select('id').single()
    if (error) return queueFailed('membership_purchase', error)
    {
      const { notifyAgentApprovalRequest } = await import('./approval-notify')
      await notifyAgentApprovalRequest(db, {
        requestId: inserted?.id, locationId, kind: 'membership_purchase', customerName: ctx.nameHint,
        summary: details.offer || details.note || 'membership purchase request',
      })
    }
    return {
      requested: true,
      kind: 'membership_purchase',
      message: 'Queued for the team — tell the customer they will set it up and confirm shortly. Never say it is done.',
    }
  }

  const verifiedId = verifiedContactId
  if (!verifiedId) {
    return { error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first.' }
  }

  if (toolName === 'get_my_membership') {
    // PERSON-ACCT.3 — a member's LIVE membership can sit on a sibling
    // contact row (person_groups), not the one this conversation is bound
    // to. Read the whole group and answer from whichever row is genuinely
    // best, never just the acting row. readFailed → today's single-row
    // behaviour, unchanged (never a confident wrong answer).
    const linked = await linkedAccountsForContact(db, verifiedId)
    let targetId = verifiedId
    let doubleMembership = false
    if (!linked.readFailed) {
      doubleMembership = hasDoubleMembership(linked.contacts)
      const best = pickBestMembershipContact(linked.contacts)
      if (best?.id) targetId = best.id
    }
    const { data } = await db.from('contacts')
      .select('glofox_membership_state, glofox_account_active, glofox_membership_plan, glofox_membership_plan_full')
      .eq('id', targetId)
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
    const result = formatMembership(data)
    // The model still answers normally from the chosen row — this flag is
    // for the decision log (it stringifies the whole tool result), not a
    // change in what the customer is told.
    if (doubleMembership) result.note_for_staff = 'double_membership'
    return result
  }

  if (toolName === 'get_my_next_class') {
    // PERSON-ACCT.3 — the soonest booking can be on any linked account.
    const linked = await linkedAccountsForContact(db, verifiedId)
    if (!linked.readFailed) {
      const ids = linked.contacts.map((c) => c?.id).filter(Boolean)
      try {
        const rows = await fetchContactRowsByIds(db, ids, 'recent_bookings')
        const combined = rows.flatMap((r) => (Array.isArray(r?.recent_bookings) ? r.recent_bookings : []))
        return formatNextClass(combined)
      } catch (err) {
        console.error('[agent][account] get_my_next_class group read failed:', err?.message || err)
        // fall through to the single-contact read below
      }
    }
    const { data } = await db.from('contacts')
      .select('recent_bookings')
      .eq('id', verifiedId)
      .maybeSingle()
    return formatNextClass(data?.recent_bookings)
  }

  if (toolName === 'get_my_recent_attendance') {
    // PERSON-ACCT.3 — attendance rolls up per account; merge across the
    // group so a class attended on a sibling account still counts.
    const linked = await linkedAccountsForContact(db, verifiedId)
    if (!linked.readFailed) {
      const ids = linked.contacts.map((c) => c?.id).filter(Boolean)
      try {
        const rows = await fetchContactRowsByIds(
          db, ids, 'total_attended_30d, total_attended_7d, last_attended_at',
        )
        return formatRecentAttendance(mergeRecentAttendanceRows(rows))
      } catch (err) {
        console.error('[agent][account] get_my_recent_attendance group read failed:', err?.message || err)
        // fall through to the single-contact read below
      }
    }
    const { data } = await db.from('contacts')
      .select('total_attended_30d, total_attended_7d, last_attended_at')
      .eq('id', verifiedId)
      .maybeSingle()
    return formatRecentAttendance(data)
  }

  if (toolName === 'request_pause' || toolName === 'request_cancellation') {
    const kind = toolName === 'request_pause' ? 'pause' : 'cancellation'
    const details = kind === 'pause' ? buildPauseDetails(input) : buildCancellationDetails(input)

    // PERSON-ACCT.8 — same discipline as book_class (PERSON-ACCT.7): the
    // membership this person actually holds can live on a SIBLING contact
    // row, not the one this conversation happens to be bound to. Elect ONE
    // account to file the row against rather than always the anchor. No
    // concernsMemberIds here — pause/cancel are membership-level actions,
    // not tied to one class's booking history the way book_class is.
    //
    // Unlike book_class, staff action pause/cancellation MANUALLY in
    // Glofox after approving (there is no automated Glofox call this route
    // could run against the wrong account), so a 'conflict' still files —
    // staff decide which account is right themselves, same as they always
    // have. It is never handed off the way book_class's live account
    // conflict is: nothing here would execute incorrectly by waiting.
    const linked = await linkedAccountsForContact(db, verifiedId)
    const accounts = linked.readFailed ? [] : linked.accounts
    const election = electWriteAccount({ accounts, anchorContactId: verifiedId, locationId })

    let targetContactId = verifiedId
    if (election.outcome === 'elected') {
      targetContactId = election.account.id
      // Same convention book_class stamps — lets the executor's
      // ACCOUNT_MISMATCH-style cross-check (or an operator eyeballing the
      // card) recognise which account this request concerns.
      details.elected_glofox_member_id = election.account.glofox_member_id
    } else if (election.outcome === 'conflict') {
      const top = election.candidates[0]
      targetContactId = top.id
      // Structured data only — NEVER details.reason, which on this kind is
      // the customer's own words and is rendered as a quote on the card.
      details.candidates = election.candidates.map((c) => ({
        contact_id: c.id,
        glofox_member_id: c.glofox_member_id,
        membership_status: c.glofox_membership_status || null,
        credits: Number.isFinite(c.trial_credits_remaining) ? c.trial_credits_remaining : null,
        name: c.name || null,
      }))
    }
    // outcome 'none' (or an unreadable group) leaves targetContactId at
    // verifiedId — today's behaviour, unchanged: never a confident guess
    // when there is nothing to elect from.

    const { data: inserted, error } = await db.from('agent_membership_requests').insert({
      location_id: locationId,
      contact_id: targetContactId,
      kind,
      channel: ctx.channel || null,
      conversation_id: conversationId || null,
      details,
      customer_note: details.reason || null,
      status: 'pending',
      // Cancellations are flagged for a retention attempt by default so a
      // human can try a save before it's actioned.
      retention_flagged: kind === 'cancellation',
    }).select('id').single()
    if (error) return queueFailed(kind, error)
    {
      const { notifyAgentApprovalRequest } = await import('./approval-notify')
      await notifyAgentApprovalRequest(db, {
        requestId: inserted?.id, locationId, kind, customerName: ctx.nameHint,
        summary: details.reason || (kind === 'pause' ? 'membership pause request' : 'membership cancellation request'),
      })
    }
    return { requested: true, kind }
  }

  return { error: 'unknown_tool', tool: toolName }
}
