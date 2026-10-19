// MIAHATCH.5 Task 18 — staff approving one of Mia's Hatch Street cards
// (agent_membership_requests, kind class_booking or class_cancellation,
// details.provider 'un1t_online' and details.origin 'mia', filed by
// src/lib/agent/un1t-booking.js) executes through spec D's executeUn1tApproval.
// The approval route calls this only for such cards; a /start funnel card
// (D's) keeps D's own branch in the route unchanged.
//
// What approving does:
//   expired      the route's past-start guard already expired the card: no
//                read, no call, no message (MIA-EXPIRY-QUIET.1).
//   record-only  a booking reason in UN1T_RECORD_ONLY_REASONS: D records it,
//                nothing is checked or sent.
//   account      the card names the un1t.online account Mia chose
//                (details.un1t_user_id). D re-resolves the account from the
//                executing contact (findUn1tAccount), so before anything is
//                sent the same resolver runs here, MIRROR ONLY (the contact's
//                own link, then a same-email sibling; never the API email walk
//                or a link write). A different account, or none, is
//                ACCOUNT_MISMATCH; a failed read is UN1T_ACCOUNT_UNREADABLE.
//                Both land 'failed' on the Fix & retry lane, nothing called
//                (the PERSON-ACCT.7 rule for Glofox class bookings).
//   execute      executeUn1tApproval, the approver as actor. Its step 7 (the
//                set-password and booking confirmation emails) is replaced by
//                a no-op: E sends no email (R4). Its bookOnce runs
//                trialMode 'credits_only' (Ruling 28): a staff approval never
//                grants the €0 trial, which Mia offers only in her
//                eligible-first upsell. No credits is a failed card,
//                MIA_NO_CREDITS, in Mia's words rather than D's trial copy.
//   confirm      on 'actioned' (a real write, not a record), ONE in-thread
//                confirmation via sendAgentThreadMessage with the operator's
//                booking or cancellation text. Its answer is recorded on the
//                card (details.confirmation): a closed 24h window is recorded,
//                never retried, and no send outcome changes the card's status.
//
// Rejects only when executeUn1tApproval does (a database error before
// anything was written or sent); the route answers 500 and the card stays
// claimed, on the retry lane.
import { executeUn1tApproval } from '@/lib/un1t-online-approval-execute'
import { UN1T_RECORD_ONLY_REASONS } from '@/lib/un1t-online-approval'
import { findUn1tAccount } from '@/lib/un1t-online-account'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { un1tBookOnce } from '@/lib/un1t-online-booking-processor'
import { logWarn } from '@/lib/log'

export { isMiaUn1tCard } from './mia-un1t-card'

const LOG_MODULE = 'mia-un1t'

export const UN1T_ACCOUNT_MISMATCH = 'ACCOUNT_MISMATCH'
export const UN1T_ACCOUNT_UNREADABLE = 'UN1T_ACCOUNT_UNREADABLE'
export const MIA_NO_CREDITS = 'MIA_NO_CREDITS'
// Staff-facing. The failure label map is shared/agent-request-failure.js
// (shared with the phone, so a change there is an OTA), which reads this code
// in un1t.online's terms; the card also holds the words on details.result.message.
export const MIA_NO_CREDITS_COPY = 'No credits show in un1t.online. Add credits there, then approve again.'
// D's code for "credits_only found no credits" (un1t-online-approval-execute.js).
const D_NO_CREDITS_CODE = 'un1t_trial_unverified'

const idText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

// Thrown by the stand-ins below: the resolver reached its live step (the API
// email walk, or a link write), so the mirror holds no account for the contact.
class MirrorHasNoAccount extends Error {}
const mirrorOnly = () => { throw new MirrorHasNoAccount('mirror-only account read') }
const MIRROR_ONLY_DEPS = Object.freeze({ findClientByEmail: mirrorOnly, linkAccount: mirrorOnly, writerFactory: mirrorOnly })
// Passed as the writer so findUn1tAccount never builds a real one.
const NO_WRITER = Object.freeze({ studioId: null })

/**
 * The executing contact's un1t.online account at the card's studio, as D's
 * executor would resolve it, from the mirror only.
 * @returns {Promise<{ ok: true, un1tUserId: string|null } | { ok: false }>}
 */
async function currentAccount(db, { locationId, contactId }) {
  try {
    const { organizationId } = await readUn1tWriteSettings(db, locationId)
    const { data: contact, error } = await db.from('contacts')
      .select('id, email, un1t_user_id')
      .eq('id', contactId)
      .maybeSingle()
    if (error) throw Object.assign(new Error(`contact read failed (${error.code ?? 'no code'})`), { code: error.code ?? null })
    if (!contact) return { ok: true, un1tUserId: null }
    const found = await findUn1tAccount(db, { locationId, organizationId, contact, writer: NO_WRITER }, MIRROR_ONLY_DEPS)
    return { ok: true, un1tUserId: found.kind === 'linked' ? idText(found.un1tUserId) : null }
  } catch (err) {
    if (err instanceof MirrorHasNoAccount) return { ok: true, un1tUserId: null }
    logWarn(LOG_MODULE, 'approval account read failed', { locationId, op: 'approval_account', status: null, code: err?.code ?? null, errClass: err?.name ?? null })
    return { ok: false }
  }
}

const noEmail = async () => ({})
// Ruling 28: whatever reason the card carries, never a trial grant on approval.
const creditsOnlyBookOnce = (db, args, deps) => un1tBookOnce(db, { ...args, trialMode: 'credits_only' }, deps)
const MIA_EXECUTOR_DEPS = Object.freeze({ afterBooking: noEmail, bookOnce: creditsOnlyBookOnce })

/**
 * @param {object} db
 * @param {{ row: object, details: object, actor: { id: string }, expiredBeforeExecution: boolean }} args
 *   row: the claimed agent_membership_requests row; details: its details as the
 *   route holds them (the execution marker included).
 * @returns {Promise<{ finalStatus: string, details: object, executed: object|null,
 *   customerNotified: { sent: boolean, channel: string|null, reason?: string } | null }>}
 */
export async function executeMiaUn1tCard(db, { row, details, actor, expiredBeforeExecution }) {
  if (expiredBeforeExecution) {
    return { finalStatus: 'expired', details, executed: details?.result ?? { ok: false, reason: 'CLASS_ALREADY_STARTED' }, customerNotified: null }
  }
  const failed = (executed) => ({ finalStatus: 'failed', details: { ...details, result: executed }, executed, customerNotified: null })

  const recordOnly = row.kind === 'class_booking' && UN1T_RECORD_ONLY_REASONS.has(details?.reason)
  if (!recordOnly) {
    const expected = idText(details?.un1t_user_id)
    if (!expected) return failed({ ok: false, message_code: UN1T_ACCOUNT_MISMATCH, current_un1t_user_id: null })
    const current = await currentAccount(db, { locationId: row.location_id, contactId: details?.executing_contact_id || row.contact_id })
    if (!current.ok) return failed({ ok: false, message_code: UN1T_ACCOUNT_UNREADABLE })
    if (current.un1tUserId !== expected) {
      logWarn(LOG_MODULE, 'approval refused: the card names another un1t.online account', { locationId: row.location_id, op: 'approval_account', requestId: row.id, status: null })
      return failed({ ok: false, message_code: UN1T_ACCOUNT_MISMATCH, current_un1t_user_id: current.un1tUserId })
    }
  }

  const r = await executeUn1tApproval(db, { row: { ...row, details }, actor }, MIA_EXECUTOR_DEPS)
  let out = { finalStatus: r.finalStatus, details: r.details, executed: r.executed, customerNotified: null }
  if (out.finalStatus === 'failed' && out.executed?.code === D_NO_CREDITS_CODE) {
    const executed = { ...out.executed, code: MIA_NO_CREDITS, message_code: MIA_NO_CREDITS, message: MIA_NO_CREDITS_COPY }
    out = { ...out, executed, details: { ...out.details, result: executed } }
  }

  const confirms = out.finalStatus === 'actioned' && out.executed?.ok === true && out.executed?.record_only !== true
  if (confirms && row.conversation_id) {
    const sent = await sendConfirmation(db, row, out.details)
    out = {
      ...out,
      details: { ...out.details, confirmation: sent },
      customerNotified: { channel: row.channel || null, ...sent },
    }
  }
  return out
}

/** One in-thread confirmation; its answer, never a throw. */
async function sendConfirmation(db, row, details) {
  try {
    const notify = await import('@/lib/agent/notify')
    const templates = await notify.agentConfirmationTemplates(db, row.location_id)
    const args = { className: details?.class_name, classTime: details?.class_time }
    const text = row.kind === 'class_cancellation'
      ? notify.buildCancellationConfirmationText({ ...args, template: templates?.cancellation })
      : notify.buildBookingConfirmationText({ ...args, template: templates?.booking })
    const res = await notify.sendAgentThreadMessage(db, { channel: row.channel, conversationId: row.conversation_id, text })
    if (res?.sent === true) return { sent: true }
    return { sent: false, reason: res?.reason || 'not_sent' }
  } catch (err) {
    logWarn(LOG_MODULE, 'approval confirmation send failed', {
      locationId: row.location_id, op: 'approval_confirmation', requestId: row.id,
      status: err?.status ?? null, code: err?.code ?? null, errClass: err?.name ?? null,
    })
    return { sent: false, reason: 'send_error' }
  }
}
