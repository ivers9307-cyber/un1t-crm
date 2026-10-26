// Side effects of a race payment that THIS caller just completed (REVPAY.3).
//
// Moved out of /api/webhooks/revolut/race-payments so the reconcile cron
// (/api/cron/revolut-reconcile) runs exactly what the webhook runs when it is
// the one that settles a payment whose webhook never landed. Call it only
// when markRacePaymentStatus returned `applied.status === 'completed'` for
// this caller: that compare-and-set is what makes exactly one path send.
//
//   - EVENT-MOVE.5: a paid PRICE DIFFERENCE (kind move_gap) settled its move
//     inside markRacePaymentStatus; it gets the short gap receipt, never the
//     entry confirmation, and never the Glofox push (its people were pushed
//     when the entry was paid).
//   - an entry payment gets sendRaceConfirmations (idempotent via its
//     *_sent_at stamps) and, for opted-in events, the GLOFOX3.3 post-payment
//     Glofox push.

import { sendRaceConfirmations, sendGapPaidEmail } from './race-confirmations'
import { GAP_PAYMENT_KIND } from './registration-entry'
import { logWarn } from './log'

/**
 * GLOFOX3.3 (mig 145). Post-payment Glofox push for opted-in events. Race
 * payments don't push at registration time (would create Glofox accounts for
 * teams that abandon checkout), so the push fires once payment is confirmed.
 * Idempotency: every push routes through findOrCreateGlofoxMember, which
 * skips already-linked contacts, so a retry can't double-push. Never throws.
 */
export async function pushRacePaymentTeamToGlofox(db, paymentId) {
  try {
    const { data: pay, error: payErr } = await db
      .from('race_payments')
      .select(`
        id,
        race_registrations:race_registration_id (
          id, team_id,
          race_events:race_event_id ( id, create_in_glofox )
        )
      `)
      .eq('id', paymentId)
      .maybeSingle()
    if (payErr) {
      logWarn('revolut-race-webhook.glofox', 'payment unreadable; Glofox push skipped', { err: payErr, paymentId })
      return
    }
    const race = pay?.race_registrations?.race_events
    const teamId = pay?.race_registrations?.team_id
    if (!race?.create_in_glofox || !teamId) return
    const { findOrCreateGlofoxMember } = await import('@/lib/glofox-push')
    const { data: members, error: membersErr } = await db
      .from('team_members')
      .select(`
        name, email, role, contact_id,
        contacts:contact_id ( id, name, email, first_name, last_name, phone, dob, location_id, glofox_member_id )
      `)
      .eq('team_id', teamId)
    if (membersErr) {
      logWarn('revolut-race-webhook.glofox', 'team unreadable; Glofox push skipped', { err: membersErr, paymentId, teamId })
      return
    }
    for (const m of (members || [])) {
      if (!m.contacts || !m.contacts.id || !m.contacts.email) continue
      const c = m.contacts
      let { first_name, last_name } = c
      if ((!first_name || !last_name) && (c.name || m.name)) {
        const full = (c.name || m.name).trim().split(/\s+/)
        first_name = first_name || full[0] || ''
        last_name = last_name || (full.slice(1).join(' ') || '—')
      }
      try {
        await findOrCreateGlofoxMember({
          db,
          locationId: c.location_id,
          contact: { ...c, first_name, last_name },
          source: 'event_registration',
          createIfMissing: true,
          attachTrial: true,
        })
      } catch (e) {
        logWarn('revolut-race-webhook.glofox', `push failed for ${c.email}`, { err: e })
      }
    }
  } catch (e) {
    logWarn('revolut-race-webhook.glofox', `glofox push failed for ${paymentId}`, { err: e })
  }
}

/**
 * Run the completion side effects for a payment this caller completed.
 *
 * Returns `{ confirmations, glofoxPush }`. `glofoxPush` is a thunk that runs
 * the push (its promise never rejects), or null when there is none. It is NOT
 * started here: the webhook hands it to next/server's after() so it runs once
 * the response is sent (REVPAY.1); the cron awaits `glofoxPush()` inline.
 *
 * @param {{ db: object, payment: { id: string, kind?: string }, applied: object|null }} args
 */
export async function runRacePaymentCompletedEffects({ db, payment, applied }) {
  if (applied?.status !== 'completed') return { confirmations: null, glofoxPush: null }
  if (payment.kind === GAP_PAYMENT_KIND) {
    let confirmations
    try {
      confirmations = await sendGapPaidEmail({ db, paymentId: payment.id })
    } catch (e) {
      console.warn(`[revolut-race-webhook] gap receipt failed for ${payment.id}: ${e.message}`)
      confirmations = { failed: [`unhandled:${e.message}`] }
    }
    return { confirmations, glofoxPush: null }
  }
  let confirmations
  try {
    confirmations = await sendRaceConfirmations({ db, paymentId: payment.id })
  } catch (e) {
    console.warn(`[revolut-race-webhook] confirmations failed for ${payment.id}: ${e.message}`)
    confirmations = { failed: [`unhandled:${e.message}`] }
  }
  const glofoxPush = () => pushRacePaymentTeamToGlofox(db, payment.id)
  return { confirmations, glofoxPush }
}
