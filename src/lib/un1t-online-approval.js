// UN1TWRITE.8 — approval cards for un1t.online work. This part: the RECORD-ONLY
// refund card.
//
// The CRM never moves money on un1t.online (no /refunds, no forceRefund, no
// /credits/grant: the guard in tests/un1t-online-write-guard.test.js bans them
// across src/). When a refund is owed (a double payment, a member's request, a
// late cancel), fileRefundCard puts a pending `refund_request` card in front
// of staff, who do the refund by hand in the un1t.online owner console and
// then approve the card to record that it is done. Approving calls nothing:
// the PATCH route closes the card as 'actioned' with { ok: true, record_only:
// true }.
//
// So this module imports NOTHING from the write side (the transport, its ops,
// its ledger, the judge, the mirror) and no Glofox or un1t.online client; the
// guard walks its imports to prove it. Task 23 adds the booking executor to
// this file; keep the refund path free of it (see the guard's note).
//
// It never throws: it is called from a Mia turn and from settle paths, neither
// of which may crash on a failed filing. A failed insert resolves
// { approvalId: null } after a structured log naming the ids.
import { logError, logWarn } from '@/lib/log'
import { approvalCardSummary } from '@shared/approval-cards'

const MODULE = 'un1t-online-approval'
const KIND = 'refund_request'
const TABLE = 'agent_membership_requests'

/**
 * Find a PENDING refund card for the same person, reason and origin_ref, or
 * null. The person is the contact, or (with no contact) the un1t.online user;
 * with neither there is nothing safe to match on and nothing is merged.
 * A read failure is logged and treated as "none found": a missed card is worse
 * than a duplicate one.
 *
 * ACCEPTED LIMITATION (same as routeToReview): SELECT-then-INSERT, with no
 * unique index behind it. Two callers filing the same refund in the same
 * instant can both miss and both insert.
 */
async function findPendingRefundCard(db, { locationId, contactId, un1tUserId, reason, originRef }) {
  if (!contactId && !un1tUserId) return null
  try {
    let q = db.from(TABLE).select('id')
      .eq('location_id', locationId)
      .eq('kind', KIND)
      .eq('status', 'pending')
      .eq('details->>reason', reason)
    q = originRef == null ? q.is('details->>origin_ref', null) : q.eq('details->>origin_ref', String(originRef))
    q = contactId ? q.eq('contact_id', contactId) : q.is('contact_id', null).eq('details->>un1t_user_id', un1tUserId)
    const { data, error } = await q.limit(1).maybeSingle()
    if (error) throw error
    return data?.id || null
  } catch (e) {
    logWarn(MODULE, 'refund card lookup failed; filing a new card', { locationId, contactId, un1tUserId, reason, err: e })
    return null
  }
}

/** The approvers' push, once per new card. Best-effort: never undoes the card. */
async function notifyApprovers(db, { approvalId, locationId, contactId, reason, amountCents, currency }) {
  try {
    let customerName = null
    if (contactId) {
      const { data } = await db.from('contacts').select('name').eq('id', contactId).maybeSingle()
      customerName = data?.name || null
    }
    const { notifyAgentApprovalRequest } = await import('@/lib/agent/approval-notify')
    await notifyAgentApprovalRequest(db, {
      requestId: approvalId,
      locationId,
      kind: KIND,
      customerName,
      // One wording everywhere: the shared card summary ('Double payment · €15').
      summary: approvalCardSummary({ kind: KIND, details: { reason, amount_cents: amountCents, currency } }),
    })
  } catch (e) {
    logWarn(MODULE, 'refund card notify failed', { approvalId, locationId, err: e })
  }
}

/**
 * File a pending, record-only refund_request card.
 *
 * @param {object} db  service-role supabase client
 * @param {{
 *   locationId: string, contactId: string|null, un1tUserId: string|null,
 *   reason: 'double_payment'|'member_request'|'late_cancel'|string,
 *   bookingId?: string|null, transactionIds?: string[], amountCents?: number|null,
 *   currency?: string|null,
 *   origin: 'staff'|'funnel'|'approval'|'mia'|'test_account', originRef?: string|null,
 *   conversationId?: string|null, channel?: 'whatsapp'|'instagram'|null,
 * }} args
 * @returns {Promise<{ approvalId: string|null }>} null = nothing was filed (logged)
 */
export async function fileRefundCard(db, args = {}) {
  const {
    locationId, contactId = null, un1tUserId = null, reason, bookingId = null,
    transactionIds = [], amountCents = null, currency = null, origin,
    originRef = null, conversationId = null, channel = null,
  } = args || {}
  const ids = { locationId, contactId, un1tUserId, reason, origin, originRef }
  try {
    if (!locationId || !reason) {
      logError(MODULE, 'refund card not filed: a studio and a reason are required', ids)
      return { approvalId: null }
    }

    const existing = await findPendingRefundCard(db, { locationId, contactId, un1tUserId, reason, originRef })
    if (existing) return { approvalId: existing }

    const { data, error } = await db.from(TABLE).insert({
      location_id: locationId,
      contact_id: contactId,
      kind: KIND,
      status: 'pending',
      channel,
      conversation_id: conversationId,
      details: {
        provider: 'un1t_online',
        un1t_user_id: un1tUserId,
        reason,
        booking_id: bookingId,
        transaction_ids: Array.isArray(transactionIds) ? transactionIds : [],
        amount_cents: amountCents,
        currency,
        origin,
        origin_ref: originRef,
        record_only: true,
      },
    }).select('id').maybeSingle()
    if (error || !data?.id) {
      logError(MODULE, 'refund card insert failed', { ...ids, err: error || new Error('insert returned no row') })
      return { approvalId: null }
    }

    await notifyApprovers(db, { approvalId: data.id, locationId, contactId, reason, amountCents, currency })
    return { approvalId: data.id }
  } catch (e) {
    logError(MODULE, 'refund card filing threw', { ...ids, err: e })
    return { approvalId: null }
  }
}
