// WAITLIST.4 — placing a public-form signup on the location's board.
//
// Both live public forms do this: /api/public/leads (the website waitlist /
// lead capture) and /api/public/class-booking (/start's class path). They had
// grown the same twenty lines twice, which is how the two copies drift.
//
// Best-effort by contract: losing a deal placement must never cost the lead
// capture, which is why every caller wraps this in a try/catch and why nothing
// here throws or returns a failure. Every Supabase call destructures `error`
// and logs it — a silently failed write here is a lead that reaches nobody's
// board with no line saying so.

import { logWarn } from '@/lib/log'
import {
  findOpenDealForPipeline,
  findPrimaryPipeline,
  findEntryStageForPipeline,
} from '@/lib/deal-lookup'

/**
 * Open (or re-open) this contact's place on the location's primary board.
 *
 * PIPELINES.5 rewrote all three lines of the insert this wraps, and the
 * reasoning belongs with the code:
 *  • the open-deal check was `.maybeSingle()`, which ERRORS on a second row.
 *    Nothing enforces one open deal per contact, so the first location to run
 *    a second board turns the live website form into a 500.
 *  • the stage was the hardcoded slug 'new_lead' scoped to the LOCATION. A
 *    location running two boards has two stage sets; the board's own entry
 *    column is the right answer and resolves to new_lead at Stillorgan.
 *  • the insert wrote no pipeline_id, and the nightly orchestrator scopes its
 *    deal read with `.in('pipeline_id', …)`, which never matches NULL — so the
 *    cron could not see this deal and opened ANOTHER for the same contact,
 *    every night, for every new lead.
 *
 * WAITLIST.4 adds the re-signup bump, MANUAL BOARDS ONLY. A contact who
 * already had an open deal used to be skipped outright, so someone a member of
 * staff had parked in "Not interested" and who then filled the waitlist form in
 * again stayed in "Not interested", and nobody was told. On a manual board a
 * re-submission now moves that deal back to the entry column (Richard,
 * 2026-09-08). It is RETURNPIPE.3's rule one layer up: being parked is a
 * judgement about someone who went quiet, and filling the form in again is that
 * person answering.
 *
 * On a DERIVED board nothing moves. The classifier owns placement there, so a
 * bump would be reverted on the next pass — a move that un-does itself
 * overnight is worse than no move, because the board shows it happening. That
 * fence (`pipelines.mode`, mig 594) is the same one /api/deals/[id]/stage
 * enforces, and it is what keeps Stillorgan's behaviour identical to before.
 *
 * @param {object} db                  service-role Supabase client
 * @param {object} args
 * @param {string} args.contactId
 * @param {string} args.locationId
 * @param {string} args.title          deal title; each form words its own
 * @returns {Promise<void>}            never throws, never reports failure
 */
export async function placeWaitlistEntry(db, { contactId, locationId, title } = {}) {
  if (!db || !contactId || !locationId) return

  try {
    const primary = await findPrimaryPipeline(db, locationId)
    if (!primary) return

    const openDeal = await findOpenDealForPipeline(db, contactId, primary.id)

    // Derived board, deal already open: today's behaviour exactly — leave it
    // to the classifier. Returning here also means the entry column is never
    // read on that path.
    if (openDeal && primary.mode !== 'manual') return

    const stage = await findEntryStageForPipeline(db, primary.id)
    if (!stage) return

    if (openDeal) {
      // Already at the front of the board: write nothing. Mig 458's
      // BEFORE-UPDATE trigger only stamps stage_entered_at on a real change,
      // but a no-op UPDATE would still reset nothing and log nothing useful,
      // so skip it outright.
      if (openDeal.stage_id === stage.id) return

      // Deliberately NOT firing triggerSequencesForDealPlacement here, unlike
      // the staff-driven move in /api/deals/[id]/stage: that would start a
      // pipeline_stage_change sequence off a public form submission, which is
      // a customer-messaging decision nobody has taken. Mig 155's trigger
      // still re-derives contacts.pipeline_stage_slug on any deal UPDATE, and
      // since mig 595 it reads the PRIMARY board — which Hatch's waitlist board
      // is — so the audience field follows the card here instead of going
      // stale against it.
      const { error: bumpErr } = await db
        .from('deals')
        .update({ stage_id: stage.id })
        .eq('id', openDeal.id)
      if (bumpErr) {
        logWarn('waitlist', 'deal bump failed', { err: bumpErr.message, contactId })
      }
      return
    }

    const { error: dealErr } = await db.from('deals').insert({
      title,
      contact_id: contactId,
      stage_id: stage.id,
      location_id: locationId,
      pipeline_id: primary.id,
      status: 'open',
    })
    if (dealErr) {
      logWarn('waitlist', 'deal create failed', { err: dealErr.message, contactId })
    }
  } catch (e) {
    logWarn('waitlist', 'deal placement failed', { err: e, contactId })
  }
}
