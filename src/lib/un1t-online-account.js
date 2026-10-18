// UN1TWRITE.20 — find, link or create a person's un1t.online account for the
// funnel (spec D 6.5 steps 2, 3 and 7).
//
// Find, mirror first:
//   (a) the funnel contact's own un1t_user_id with a un1t_clients row here;
//   (b) another contact in the organisation with the SAME email (trimmed,
//       lower-cased, exact: `.ilike` with escapeLikePattern, then compared in
//       JS) linked to a client here, which becomes the executing contact. A
//       phone-only match is never used (couples share numbers, PERSON-ACCT.9);
//   (c) the API email walk (findClientByEmail, bounded): one → link the
//       funnel contact (the create mirror's semantics: never over another
//       link); several, or a walk cut short by the page cap → ambiguous; a
//       failed walk throws (the queue retries; nothing is written yet).
// Create only with a recorded acceptance of un1t.online's terms and waiver on
// the request (no tick, no create: terms_not_accepted). An "email in use"
// refusal walks again: one → link it as existing; none (in use elsewhere in
// the franchise) → un1t_email_in_use_elsewhere.
//
// The set-password step runs only when the CRM created THIS person's account
// (a done create_client on their ledger) and no done forgot-password exists
// for that un1t.online user: our explanation email first (skipped when
// un1t.online sends its own welcome), then POST /auth/forgot-password
// (skipped when that welcome also lets them set a password). Our email
// failing never blocks the call. The pw:<loc>:<user> key allows one reset per
// person ever; a reset that answered unclearly stays in doubt on the ledger,
// and the person can always use "Forgot password" in the un1t.online app
// (UN1T_SET_PASSWORD_HELP is the staff-facing line for that).

import { escapeLikePattern } from './like-escape.js'
import { classifyRefusal } from './un1t-online-write-judge.js'
import { createUn1tWriter } from './un1t-online-write.js'
import {
  createClient as createClientOp,
  forgotPassword as forgotPasswordOp,
  findClientByEmail as findClientByEmailOp,
} from './un1t-online-write-ops.js'
import { applyUn1tWriteToMirror } from './un1t-online-mirror-write.js'
import { findDone, ledgerKey, listAttempts } from './un1t-online-write-ledger.js'
import { logWarn } from './log'

const LOG = 'un1t-online-write'

/** What staff read when un1t.online's set-password email may not have gone out. */
export const UN1T_SET_PASSWORD_HELP = 'un1t.online may not have sent the set-password email. The person can tap "Forgot password" in the un1t.online app to get a new code.'

const normEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
const idText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

// The live link: write the funnel contact's un1t_user_id (only where it is
// empty) and the un1t_clients row, exactly as a CRM-created account is linked.
async function defaultLinkAccount(db, { locationId, contactId, un1tUserId, writer }) {
  const m = await applyUn1tWriteToMirror(db, {
    op: 'create_client', locationId, contactId, un1tUserId, studioId: writer?.studioId ?? null, data: null, requestedAt: null, ledgerId: null,
  }, { read: (path) => writer.read(path) })
  return { ok: m.ok !== false && !m.conflict, conflict: m.conflict ?? null }
}

function depsOf(deps = {}) {
  return {
    writerFactory: deps.writerFactory ?? createUn1tWriter,
    findClientByEmail: deps.findClientByEmail ?? findClientByEmailOp,
    createClient: deps.createClient ?? createClientOp,
    forgotPassword: deps.forgotPassword ?? forgotPasswordOp,
    linkAccount: deps.linkAccount ?? defaultLinkAccount,
    sendUn1tAccountEmail: deps.sendUn1tAccountEmail,
  }
}

async function clientAt(db, locationId, un1tUserIds) {
  if (un1tUserIds.length === 0) return []
  const { data, error } = await db.from('un1t_clients').select('un1t_user_id').eq('location_id', locationId).in('un1t_user_id', un1tUserIds)
  if (error) throw Object.assign(new Error(`un1t_clients read failed (${error.code ?? 'no code'})`), { code: error.code ?? null })
  return [...new Set((data || []).map((r) => idText(r.un1t_user_id)).filter(Boolean))]
}

// (c) the API walk: { matches } or 'truncated' (cut short by the page cap).
async function walk(d, writer, email) {
  try {
    return await d.findClientByEmail(writer, email)
  } catch (err) {
    if (err?.code === 'truncated') return 'truncated'
    throw err
  }
}

/**
 * @returns {Promise<{ kind: 'linked', un1tUserId: string, executingContactId: string } | { kind: 'none' }
 *   | { kind: 'ambiguous' } | { kind: 'conflict' }>} throws when a read or the API walk failed.
 */
export async function findUn1tAccount(db, { locationId, organizationId, contact, writer = null }, deps = {}) {
  const d = depsOf(deps)
  // (a) the contact's own link, with an account at this studio.
  const own = idText(contact?.un1t_user_id)
  if (own && (await clientAt(db, locationId, [own])).length > 0) {
    return { kind: 'linked', un1tUserId: own, executingContactId: contact.id }
  }

  const email = normEmail(contact?.email)
  if (!email) return { kind: 'none' }

  // (b) a sibling in the organisation with the same email, linked here.
  const { data: siblings, error } = await db
    .from('contacts')
    .select('id, email, un1t_user_id')
    .eq('organization_id', organizationId)
    .ilike('email', escapeLikePattern(email))
    .neq('id', contact.id)
    .not('un1t_user_id', 'is', null)
    .limit(50)
  if (error) throw Object.assign(new Error(`contacts sibling read failed (${error.code ?? 'no code'})`), { code: error.code ?? null })
  const sameEmail = (siblings || []).filter((s) => normEmail(s.email) === email && idText(s.un1t_user_id))
  if (sameEmail.length > 0) {
    const here = await clientAt(db, locationId, [...new Set(sameEmail.map((s) => idText(s.un1t_user_id)))])
    if (here.length > 1) return { kind: 'ambiguous' }
    if (here.length === 1) {
      const sib = sameEmail.find((s) => idText(s.un1t_user_id) === here[0])
      return { kind: 'linked', un1tUserId: here[0], executingContactId: sib.id }
    }
  }

  // (c) the API email walk.
  const w = writer ?? (await d.writerFactory(db, locationId))
  const found = await walk(d, w, email)
  if (found === 'truncated') return { kind: 'ambiguous' }
  if (found.matches.length > 1) return { kind: 'ambiguous' }
  if (found.matches.length === 0) return { kind: 'none' }
  const un1tUserId = found.matches[0]
  const link = await d.linkAccount(db, { locationId, contactId: contact.id, un1tUserId, writer: w })
  if (link?.conflict) return { kind: 'conflict' }
  return { kind: 'linked', un1tUserId, executingContactId: contact.id }
}

const card = (reason) => ({ kind: 'card', reason })

/**
 * @returns {Promise<{ kind: 'existing'|'created', un1tUserId: string, executingContactId: string }
 *   | { kind: 'card', reason: 'account_ambiguous'|'terms_not_accepted'|'un1t_email_in_use_elsewhere'|string }
 *   | { kind: 'retry', code: string }>}
 */
export async function ensureUn1tAccount(db, { locationId, organizationId, contact, request, origin, originRef = null, actor = null }, deps = {}) {
  const d = depsOf(deps)
  const writer = await d.writerFactory(db, locationId)
  const found = await findUn1tAccount(db, { locationId, organizationId, contact, writer }, deps)
  if (found.kind === 'linked') return { kind: 'existing', un1tUserId: found.un1tUserId, executingContactId: found.executingContactId }
  if (found.kind === 'ambiguous') return card('account_ambiguous')
  if (found.kind === 'conflict') return card('un1t_link_conflict')

  // No account: create one, only with a recorded acceptance.
  if (!request?.terms_accepted_at) return card('terms_not_accepted')
  const r = await d.createClient(db, {
    locationId, contact,
    terms: { acceptedAt: request.terms_accepted_at, source: request.terms_source ?? null, version: request.terms_version ?? null },
    origin, originRef, actor,
  })
  if (r.verdict === 'done') {
    if (r.conflict) return card('un1t_link_conflict')
    const id = idText(r.id)
    if (!id) return card('un1t_outcome_unknown')
    return { kind: 'created', un1tUserId: id, executingContactId: contact.id }
  }
  if (r.verdict === 'unknown') return card('un1t_outcome_unknown')
  if (r.retryable) return { kind: 'retry', code: r.code }
  if (r.code === 'terms_not_accepted') return card('terms_not_accepted')
  if (classifyRefusal({ code: r.code, message: r.message }) === 'email_in_use') {
    const again = await walk(d, writer, normEmail(contact.email))
    if (again === 'truncated' || again.matches.length > 1) return card('account_ambiguous')
    if (again.matches.length === 0) return card('un1t_email_in_use_elsewhere')
    const link = await d.linkAccount(db, { locationId, contactId: contact.id, un1tUserId: again.matches[0], writer })
    if (link?.conflict) return card('un1t_link_conflict')
    return { kind: 'existing', un1tUserId: again.matches[0], executingContactId: contact.id }
  }
  return card(`un1t_create_failed:${r.code ?? 'unknown'}`)
}

/**
 * The set-password step (spec 6.5 step 7). Never throws on the email; throws
 * only on a ledger read failure (the queue retries; nothing was sent).
 * @returns {Promise<{ explanation: string, forgotPassword: string }>}
 */
export async function runSetPasswordStep(db, { locationId, contact, un1tUserId, request, settings, origin, emailArgs = {} }, deps = {}) {
  const d = depsOf(deps)
  const creates = await listAttempts(db, { locationId, contactId: contact.id, op: 'create_client' })
  if (!creates.some((r) => r.stage === 'done' && idText(r.un1t_ref) === un1tUserId)) {
    return { explanation: 'skipped_not_created', forgotPassword: 'skipped_not_created' }
  }
  if (await findDone(db, { key: ledgerKey.pw(locationId, un1tUserId) })) {
    return { explanation: 'skipped_already_done', forgotPassword: 'skipped_already_done' }
  }

  let explanation
  if (settings?.sendsWelcome) {
    explanation = 'skipped_flag'
  } else {
    try {
      const sent = await d.sendUn1tAccountEmail(db, {
        locationId, contact, className: request?.class_name ?? null, startsAt: request?.starts_at ?? null, ...emailArgs,
      })
      explanation = sent?.sent ? 'sent' : (sent?.reason || 'not_sent')
    } catch {
      logWarn(LOG, 'the account explanation email threw; the reset still goes', { locationId, op: 'forgot_password', code: 'send_error' })
      explanation = 'send_error'
    }
  }

  if (settings?.sendsWelcome && settings?.welcomeSetsLogin) return { explanation, forgotPassword: 'skipped_flag' }
  const r = await d.forgotPassword(db, { locationId, contactId: contact.id, un1tUserId, email: contact.email, origin, originRef: request?.id ?? null })
  return { explanation, forgotPassword: r.verdict }
}
