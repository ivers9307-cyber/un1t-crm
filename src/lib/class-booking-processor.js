// Decision-tree for one class_booking_requests row (run by the
// process-class-bookings cron). Prior-attendance books against the
// account's EXISTING balance (credits or an active membership); only a
// returner with nothing to book with goes to staff review — and a
// returner is never auto-granted a fresh trial. Brand-new leads: ensure a
// Glofox account + trial credit, book the class, send the
// booking_class_confirmed WhatsApp. Any failure → review, except a read
// that could not be made (unreadable settings, an unreadable credits
// balance): those THROW so the queue retries them first.
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, createBooking, interpretBookingResult, fetchUserCreditsResult, fetchUserBookingsResult, GLOFOX_BOOKING_MODEL } from '@/lib/glofox'
import { computeCreditsRemaining } from '@/lib/glofox-sync'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'
import { hasBookableMembership, personRowsForContact, corroborated, reusableSibling, electWriteAccount, chunkIds } from '@/lib/person-accounts'
import { maybeSendBookingWhatsappConfirm, CLASS_CONFIRM_TEMPLATE } from '@/lib/automations/booking-whatsapp-confirm'
import { sendCtwaConversion, sendWebsiteConversion } from '@/lib/meta-capi'
import { logWarn } from '@/lib/log'

const labelFmt = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
function classLabel(startsAt) {
  if (!startsAt) return 'your class'
  const d = new Date(startsAt)
  return isNaN(d.getTime()) ? 'your class' : labelFmt.format(d)
}
const MAX_ATTEMPTS = 3 // keep in sync with the process-class-bookings cron

async function setStatus(db, id, fields) {
  try { await db.from('class_booking_requests').update(fields).eq('id', id) } catch (e) { logWarn('cbp', 'status update failed', { err: e }) }
}

// CBPCREDITREAD.1 — a Glofox credits read that FAILED (still 429/5xx after
// glofoxFetch's own retries, any other non-2xx, a network throw) is
// "unknown", never "no credits". fetchUserCredits collapsed it into [], so the
// booking reached staff as needs_credit_grant (whose APPROVE buys the trial
// membership: membership-requests/[id]/route.js) or prior_attendance ("no
// usable balance was found"), and staff were told to grant a credit the
// member may already hold. A THROW is the queue's retry signal
// (class-booking-queue.js): re-queued under MAX_ATTEMPTS, then a staff card
// whose reason is reviewReason, 'credit_check_failed' (its copy says the
// balance is unknown, and approving it grants nothing).
//
// reviewOptions is routeToReview's 4th argument, passed through by the queue:
// the throw can come AFTER the processor elected a sibling's account for the
// write, and the card filed at the cap must still name it (executing_contact_id
// + elected_glofox_member_id). Without it, approving falls back to the funnel
// contact, which has no Glofox account, and answers NOT_EXECUTABLE.
export class CreditReadError extends Error {
  constructor({ personContactIds = null, executingContactId = null, electedMemberId = null } = {}) {
    super('credit_check_failed')
    this.name = 'CreditReadError'
    this.reviewReason = 'credit_check_failed'
    this.reviewOptions = { personContactIds, executingContactId, electedMemberId }
  }
}

// A credits read as a three-way answer: { ok: true, remaining > 0 }, a known
// nothing ({ ok: true, remaining: 0 | null }; computeCreditsRemaining is null
// for "no active pack"), or unread ({ ok: false }).
async function readCredits(creds, memberId) {
  const { ok, credits } = await fetchUserCreditsResult(creds, memberId)
  return ok ? { ok: true, remaining: computeCreditsRemaining(credits) } : { ok: false, remaining: null }
}
// Exported for class-booking-queue.js (REGISTRYREAD.1a): a booking that
// exhausts its retries on a THROW lands here too, so staff get a card rather
// than a bare needs_review nobody is shown. Also run by the cron's reaper for
// rows stuck in 'processing' past the attempt cap.
export async function routeToReview(db, request, reason, { personContactIds = null, executingContactId = null, electedMemberId = null } = {}) {
  let approvalId = null
  // A row that ALREADY names a card keeps it while that card is still pending
  // — never file a second one for the same booking. The person-wide lookup
  // below would usually find it too, but only by (contact, event), so a card
  // filed against a sibling contact would slip through it. A card that has
  // since been decided is not reused (the row would point at a closed card);
  // an unreadable one IS reused, because a second card staff could approve
  // twice is the worse of the two errors.
  if (request.approval_request_id) {
    try {
      const { data: linked, error } = await db.from('agent_membership_requests')
        .select('id, status').eq('id', request.approval_request_id).maybeSingle()
      if (error) throw error
      if (linked?.status === 'pending') approvalId = linked.id
    } catch (e) {
      logWarn('cbp', 'linked review lookup failed; keeping the existing card', { err: e })
      approvalId = request.approval_request_id
    }
  }
  // Reuse an existing pending review item for this (PERSON, class) so a
  // re-submit/retry can't create a duplicate that staff approve twice.
  //
  // PERSON-ACCT.9 — the match is person-wide, not (contact, class): one
  // person routinely holds 2-3 contacts rows, and a returner who re-submits
  // the public form under a new email arrives as a NEW row, so a
  // contact-scoped lookup saw no pending request and filed a second card for
  // the same human and the same class. Ids = this row + every sibling the
  // REUSE rule accepts (a vetted person_group member, or an exact email
  // match — never a phone-only direct match, which may be a partner: see
  // reusableSibling), chunked at ≤150 per `.in()`.
  //
  // ACCEPTED LIMITATION: this is still SELECT-then-INSERT with no DB
  // constraint behind it (agent_membership_requests has no unique index on
  // (contact_id, kind, details->>event_id) — a jsonb expression index nothing
  // else needs). Two processors draining the same class in the same instant
  // can both miss and both insert. Widening the SELECT shrinks the window it
  // covers; it does not close the race.
  const dedupeIds = (personContactIds && personContactIds.length)
    ? personContactIds
    : [request.contact_id]
  if (!approvalId) {
    try {
      for (const batch of chunkIds(dedupeIds)) {
        const { data: existing, error } = await db.from('agent_membership_requests')
          .select('id').in('contact_id', batch).eq('kind', 'class_booking').eq('status', 'pending')
          .contains('details', { event_id: request.glofox_event_id }).limit(1).maybeSingle()
        if (error) throw error
        if (existing?.id) { approvalId = existing.id; break }
      }
    } catch (e) { logWarn('cbp', 'review lookup failed', { err: e }) }
  }

  if (!approvalId) {
    try {
      const { data: amr } = await db.from('agent_membership_requests').insert({
        location_id: request.location_id, contact_id: request.contact_id, kind: 'class_booking', status: 'pending',
        details: {
          event_id: request.glofox_event_id, class_name: request.class_name, class_time: classLabel(request.starts_at),
          // ISO start for the mobile queue's countdown chip (class_time is a label).
          starts_at: request.starts_at || null,
          mode: 'draft', source: 'start_funnel', reason,
          // PERSON-ACCT.9 — the row is FILED against the funnel contact
          // (attribution: ctwa_clid, and the phone the customer just typed is
          // where the confirmation goes), but the write may belong to a
          // SIBLING's Glofox account. Name both, the same way book_class does,
          // so the executor runs against the account that was chosen and the
          // ACCOUNT_MISMATCH cross-check has something to compare.
          ...(executingContactId ? { executing_contact_id: executingContactId } : {}),
          ...(electedMemberId ? { elected_glofox_member_id: electedMemberId } : {}),
          ...(request.payment_status === 'paid'
            ? { paid: true, amount_cents: request.amount_cents, currency: request.currency || 'EUR' }
            : {}),
        },
      }).select('id').maybeSingle()
      approvalId = amr?.id || null
    } catch (e) { logWarn('cbp', 'review insert failed', { err: e }) }
  }

  if (!approvalId) {
    // Couldn't create OR find a review item — don't strand the row in
    // needs_review with no approval to act on (a silent dead-end). Retry under
    // the attempt cap, else mark failed so an operator query surfaces it.
    const next = (request.attempts || 0) + 1 >= MAX_ATTEMPTS ? 'failed' : 'queued'
    await setStatus(db, request.id, { status: next, last_error: `review_unavailable:${reason}` })
    return { outcome: next === 'failed' ? 'failed' : 'needs_review', detail: `review_unavailable:${reason}` }
  }
  await setStatus(db, request.id, { status: 'needs_review', last_error: reason, approval_request_id: approvalId })
  // APPROVALS-STUDIO.1 — a review item is a customer waiting; ping the
  // approvers. Deduped per (request, recipient), so the reuse-existing
  // path above can't double-notify. Best-effort.
  try {
    const { notifyAgentApprovalRequest } = await import('@/lib/agent/approval-notify')
    await notifyAgentApprovalRequest(db, {
      requestId: approvalId,
      locationId: request.location_id,
      kind: 'class_booking',
      customerName: request.customer_name,
      summary: [request.class_name, classLabel(request.starts_at), `needs review: ${reason}`].filter(Boolean).join(' · '),
    })
  } catch (e) { logWarn('cbp', 'approval notify failed', { err: e }) }
  return { outcome: 'needs_review', detail: reason }
}

export async function processClassBookingRequest(db, request) {
  const creds = await glofoxCredentialsForLocation(db, request.location_id)
  // REGISTRYREAD.1a: an unreadable settings row is not "not configured".
  // 'failed' is terminal and nothing retries it; a THROW is the queue's
  // documented retry signal (class-booking-queue.js: re-queue under
  // MAX_ATTEMPTS, then needs_review with a staff card, reason
  // 'processing_error'). A blip costs a 2-minute retry, never the
  // customer's class.
  if (creds.readError) throw new Error(creds.readError)
  if (missingGlofoxCredentialsForLocation(creds).length) {
    await setStatus(db, request.id, { status: 'failed', last_error: 'glofox_not_configured' })
    return { outcome: 'failed', detail: 'glofox_not_configured' }
  }
  const { data: contact } = await db.from('contacts')
    // last_name is REQUIRED: findOrCreateGlofoxMember's create path hard-guards on
    // first_name AND last_name — omitting it would fail every brand-new lead.
    // glofox_membership_status + glofox_membership_state: the attended-path
    // balance gate reads both (hasBookableMembership needs both columns).
    // PERSON-ACCT.9 — trial_credits_remaining, updated_at and location_id are
    // read by electWriteAccount (tier, recency tiebreak, location guard) and
    // by corroborated(); without them the anchor's OWN row would rank below
    // every sibling in a tie and could lose a write it should have kept.
    .select('id, first_name, last_name, name, email, phone, wa_phone, glofox_member_id, glofox_membership_status, glofox_membership_state, trial_credits_remaining, last_attended_at, updated_at, location_id, ctwa_clid')
    .eq('id', request.contact_id).maybeSingle()
  if (!contact) {
    await setStatus(db, request.id, { status: 'failed', last_error: 'contact_missing' })
    return { outcome: 'failed', detail: 'contact_missing' }
  }
  const firstName = contact.first_name || (contact.name ? contact.name.split(' ')[0] : '') || 'there'

  // PERSON-ACCT.9 — judge the PERSON, not this row.
  //
  // A returner who fills the public form with a NEW email becomes a NEW
  // contacts row with no glofox_member_id, so every "is this a returner?"
  // check below saw a blank slate, MINTED a second Glofox account and granted
  // a second free trial. That is how one human ends up with 2-3 accounts (879
  // of 887 person groups are divergent). Resolve the person first — the
  // person-group union AND a direct phone/email search, because a row created
  // seconds ago by a public form is not in any group yet.
  const person = await personRowsForContact(db, {
    contactId: contact.id, contact, locationId: request.location_id,
  })
  const siblings = person.rows
  const viaGroup = new Set(person.groupContactIds)
  // THREE tiers of evidence, each admitting a different decision. Collapsing
  // any two of them is a defect, not a simplification:
  //
  //  • REUSABLE — a vetted person_group member, or an exact email match
  //    (reusableSibling). Only these may receive a WRITE: a booking, a credit
  //    spend, a membership ride. A phone-only match from the direct search is
  //    NOT here, because couples share numbers — 62 live phone-groups at
  //    Stillorgan carry different first names and 59 of them hold multiple
  //    Glofox accounts, so reusing on a phone alone books person B's class on
  //    person A's account. core.js's resolveAutoVerify refuses the same
  //    "couple case" for the same reason.
  //  • CORROBORATED (shares a phone or an email) — enough to READ across for
  //    the attendance judgment, which can only ever make us MORE conservative
  //    (it withholds a free trial and sends the case to staff; it spends
  //    nothing and books nothing).
  //  • everything else we can see at all — enough to REFUSE to mint a
  //    duplicate account, which is a human decision, never a write.
  const reusableAccounts = siblings.filter((row) => (
    row.glofox_member_id && reusableSibling(contact, row, { viaGroup: viaGroup.has(row.id) })
  ))
  const corroboratedAccounts = siblings.filter((row) => row.glofox_member_id && corroborated(contact, row))
  // Anything that proves a person already exists here: an account, or a
  // history of turning up. Blocks the mint below whatever its evidence tier.
  const siblingEvidence = siblings.filter((row) => row.glofox_member_id || row.last_attended_at)
  // The approval dedupe follows the REUSE rule, not corroboration: suppressing
  // this customer's card because their PARTNER already has one for the same
  // class would leave a real request with no card at all — a silent loss,
  // where the opposite error is only a second card staff can dismiss. Couples
  // train together, so same-number + same-class is exactly the collision.
  const personContactIds = [contact.id, ...siblings
    .filter((row) => reusableSibling(contact, row, { viaGroup: viaGroup.has(row.id) }))
    .map((row) => row.id)]

  // Which contact/account the WRITE belongs to. Null until an election moves
  // it off the funnel row; the funnel row itself always keeps
  // class_booking_requests.contact_id (attribution: ctwa_clid, and the
  // confirmation goes to the number the customer just typed).
  let executingContactId = null
  let electedMemberId = null
  const toReview = (reason) => routeToReview(db, request, reason, {
    personContactIds, executingContactId, electedMemberId,
  })
  // CBPCREDITREAD.1 — the retry signal carries the same account the card
  // would have named (read at throw time, like toReview above).
  const creditReadError = () => new CreditReadError({
    personContactIds, executingContactId, electedMemberId,
  })

  // AGENT-FUNNEL-CREDITS.1 — prior attendance alone no longer blocks the
  // booking (Richard 2026-08-25). /start is aimed at new people, but a
  // returner who books through it is still a customer trying to book: if
  // the account holds a usable balance (class credits, or an active
  // membership), book against it. Review is reserved for the returner with
  // NOTHING to book with — the "do they get another free class?" decision
  // staff actually need to make. Rule 5's real invariant is unchanged: a
  // returner is NEVER granted a fresh trial automatically.
  //
  // PERSON-ACCT.9 — the stamp is read across the whole person: an attendance
  // sitting on ANY sibling row is this human having trained here, so a new
  // email cannot buy a second free trial.
  //
  // This side reads WIDER than the write side on purpose, and the asymmetry is
  // the point: the widest evidence (a phone-only match that might be a
  // partner, a name-ish group row) can only ever WITHHOLD the free class and
  // hand the case to staff. It never spends a credit, never rides a
  // membership, never books. Being wrong here costs a review; being wrong on
  // the write side charges the wrong person.
  const attendedLocally = !!contact.last_attended_at || siblings.some((row) => !!row.last_attended_at)

  let memberId = contact.glofox_member_id
  // The row hasBookableMembership() is judged on — moves with the write.
  let balanceRow = contact

  // PERSON-ACCT.9 — REUSE before mint. This row carries no account, but a
  // REUSABLE sibling does (a vetted group member, or an exact email match —
  // never a phone-only direct match; see reusableSibling for the 62 live
  // couples this excludes): elect among those accounts rather than creating a
  // third one. electWriteAccount owns the choice (activity, then entitlement,
  // then recency, deterministic on the account SET) and refuses to coin-flip:
  // a genuine tie escalates instead of guessing.
  //
  // Every candidate here is already corroborated against the REAL anchor row;
  // electWriteAccount re-derives its own anchor (the anchor is absent from
  // this list, having no account) and re-applies corroboration, which can
  // only narrow the set further, never widen it to a stranger.
  //
  // A phone-only sibling holding an account falls through to the mint gate
  // below and lands on account_ambiguous — no reuse, no mint, a human decides
  // whether these two rows are one person.
  if (!memberId && reusableAccounts.length) {
    const election = electWriteAccount({
      accounts: reusableAccounts,
      anchorContactId: contact.id,
      locationId: request.location_id,
    })
    if (election.outcome === 'conflict') return toReview('account_conflict')
    if (election.outcome === 'elected') {
      memberId = election.account.glofox_member_id
      executingContactId = election.account.id
      electedMemberId = memberId
      balanceRow = election.account
    }
  }

  // Resolve identity WITHOUT creating an account: search Glofox by email +
  // link, so a repeat trainer's real account (and balance) is what we judge.
  if (!memberId) {
    const search = await findOrCreateGlofoxMember({ db, locationId: request.location_id, contact, source: 'booking_form', createIfMissing: false, attachTrial: false })
    if (search.status === 'needs_review') return toReview('account_ambiguous')
    if (search.status === 'failed') return toReview('account_failed')
    memberId = search.glofox_member_id || null // 'skipped' = no Glofox account exists
  }

  // Attendance: trust the local stamp when set; otherwise ask Glofox over a
  // WIDE window (contacts.last_attended_at can be stale/NULL for lapsed
  // trainers — the sync window is only ~30 days). An uncertain read still
  // fails safe to review: never auto-book a free class against an
  // unreadable signal.
  //
  // PERSON-ACCT.9 — the wide check now runs over every account this person
  // has that we can see (the one we are writing to, plus every CORROBORATED
  // sibling — the wider read, per the note on attendedLocally above: a
  // phone-only sibling's history can only withhold a free class, never spend
  // anything). Same reason the stamp is read person-wide: a new email must not
  // hide an attendance history. No accounts → no calls, exactly as before.
  let attended = attendedLocally
  if (!attended) {
    const attendanceMemberIds = [...new Set([
      memberId,
      ...corroboratedAccounts.map((row) => row.glofox_member_id),
    ].filter(Boolean))]
    for (const id of attendanceMemberIds) {
      const { ok: attendOk, bookings } = await fetchUserBookingsResult(creds, id, { windowDays: 365 * 5 })
      if (!attendOk) return toReview('attendance_check_failed')
      if (bookings.some((b) => b.attended === true)) { attended = true; break }
    }
  }

  // AGENT-FUNNEL-CREDITS.1's balance gate, widened to the PERSON
  // (PERSON-ACCT.9): the account we picked is confirmed empty, so check the
  // REST of this person before telling staff they have nothing to book with —
  // credits or a bookable membership on any REUSABLE, non-ClassPass account
  // counts, and the booking then executes against THAT account.
  //
  // REUSABLE, not merely corroborated: spending a partner's credits or riding
  // their membership is a wrong-account WRITE, exactly like booking on their
  // account. Unlike the attendance read above, this side pays for being
  // wrong — so a phone-only sibling is excluded here and the case goes to
  // staff instead.
  //
  // Sorted by id so the rescue is a pure function of the account SET, not of
  // fetch order (same rule as electWriteAccount). ClassPass rows are never
  // written to: those bookings are governed by ClassPass's own credit/refund
  // ledger, so a booking made directly against the Glofox member would never
  // reach it. An unreadable sibling read is skipped, never counted as empty:
  // if no readable sibling has a balance, the rescue THROWS CreditReadError
  // (CBPCREDITREAD.1) and the queue retries.
  // CBPCREDITREAD.1 — set when a sibling's credits could not be read.
  let siblingCreditsUnread = false
  async function rescueSiblingBalance() {
    const rescueable = reusableAccounts
      .filter((row) => row.glofox_member_id && row.glofox_member_id !== memberId)
      .filter((row) => row.glofox_membership_status !== 'classpass_payg')
      .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
    for (const row of rescueable) {
      let usable = hasBookableMembership(row)
      if (!usable) {
        const siblingRead = await readCredits(creds, row.glofox_member_id)
        if (!siblingRead.ok) {
          // Unknown is not empty: note it and keep looking. Another sibling
          // that DOES hold a balance still books.
          siblingCreditsUnread = true
          logWarn('cbp', 'sibling credit check unreadable', { requestId: request.id })
          continue
        }
        usable = siblingRead.remaining > 0
      }
      if (!usable) continue
      memberId = row.glofox_member_id
      executingContactId = row.id
      electedMemberId = memberId
      balanceRow = row
      return true
    }
    // Nobody we could read has a balance. If someone could NOT be read,
    // "this person has nothing to book with" is not known: retry, rather
    // than file prior_attendance / needs_credit_grant on a guess.
    if (siblingCreditsUnread) throw creditReadError()
    return false
  }

  let grantedTrial = false
  if (attended) {
    // Attended before with no Glofox account at all → nothing to book with.
    if (!memberId) return toReview('prior_attendance')
    // computeCreditsRemaining is null for BOTH "no credits" and "membership
    // without per-class credit records" — the CRM's synced membership status
    // breaks the tie: a bookable membership is bookable (Glofox arbitrates,
    // and a rejection routes to review as booking_failed below). Zero /
    // null with no bookable membership → staff.
    // hasBookableMembership, NOT status === 'active' — that string never
    // occurs in contacts.glofox_membership_status (see person-accounts.js);
    // this exact check was dead code until PERSON-ACCT.3 fixed it here.
    const activeMembership = hasBookableMembership(balanceRow)
    const read = await readCredits(creds, memberId)
    // CBPCREDITREAD.1 — an UNREAD balance is not "nothing to book with":
    // retry rather than tell staff the returner has no balance. A bookable
    // membership still books without it, exactly as before.
    if (!read.ok && !activeMembership) {
      logWarn('cbp', 'credit check unreadable; the queue retries', { requestId: request.id })
      throw creditReadError()
    }
    if (!(read.remaining > 0) && !activeMembership && !(await rescueSiblingBalance())) {
      return toReview('prior_attendance')
    }
    // Fall through to the booking — consuming the EXISTING balance, never a
    // fresh trial.
  } else if (!memberId) {
    // PERSON-ACCT.9 — the mint gate. Nothing above found an account to reuse,
    // so this is where a second Glofox account for an existing human would be
    // born. Refuse whenever we can SEE a person here already: a sibling with
    // an account we could not elect (ClassPass), or a name-ish group match we
    // will not write to, is a human decision, not a mint. Never mint on a
    // weak match.
    if (siblingEvidence.length) return toReview('account_ambiguous')
    // An unreadable sibling search is not evidence of absence either — and
    // "there is no such person" is exactly the confident negative a mint
    // rests on. Fail safe to a human.
    if (person.readFailed) return toReview('account_check_failed')
    // Truly brand-new (not found in Glofox, no sibling anywhere) → create +
    // grant the trial credit. Only a clean create/link is safe;
    // 'needs_review'/'failed' → staff.
    const trialOverride = (request.trial_membership_id && request.trial_plan_code)
      ? { membershipId: request.trial_membership_id, planCode: request.trial_plan_code }
      : null
    const res = await findOrCreateGlofoxMember({ db, locationId: request.location_id, contact, source: 'booking_form', createIfMissing: true, attachTrial: true, trialOverride })
    if (!res.glofox_member_id || (res.status !== 'created' && res.status !== 'linked')) {
      return toReview(`account_${res.status || 'failed'}`)
    }
    memberId = res.glofox_member_id
    grantedTrial = res.status === 'created'
  }
  // Existing never-attended account, no live credit → review (staff grant the
  // trial + approve); an unreadable credit read is retried (CBPCREDITREAD.1).
  // The attended path above did its own balance check.
  if (!attended && !grantedTrial) {
    // CBPCREDITREAD.1 — needs_credit_grant only on a read that WORKED: its
    // approve path buys the trial membership, so it must never rest on a read
    // that failed. Unread → retry (the queue), then credit_check_failed.
    const read = await readCredits(creds, memberId)
    if (!read.ok) {
      logWarn('cbp', 'credit check unreadable; the queue retries', { requestId: request.id })
      throw creditReadError()
    }
    if (read.remaining == null || read.remaining <= 0) {
      // PERSON-ACCT.9 — before asking staff to grant a credit, check the rest
      // of this person: a corroborated sibling may already hold a balance
      // (the same rescue the attended path makes). Only a person-wide empty
      // goes to review.
      if (!(await rescueSiblingBalance())) return toReview('needs_credit_grant')
    }
  }

  const result = await createBooking(creds, { user_id: memberId, model: GLOFOX_BOOKING_MODEL, model_id: request.glofox_event_id })
  // Success needs the created booking id — Glofox can 200 with a failure
  // body (YOU_HAVE_NO_CREDITS_LEFT), so HTTP ok alone is not enough.
  const { booked, bookingId, messageCode } = interpretBookingResult(result)
  // Glofox dedupes member+event server-side. A re-run (e.g. the reaper requeued
  // a row whose first attempt booked but died before persisting) returns
  // "already booked" — that's a SUCCESS, not a failure to push to staff review.
  const alreadyBooked = messageCode === 'YOU_HAVE_BOOKED_FOR_THIS_EVENT'
  if (!booked && !alreadyBooked) {
    return toReview(`booking_failed:${messageCode || `status_${result?.status}`}`)
  }
  // Persist the Glofox booking id so re-runs and the /approvals view can see
  // the real booking (null on the already-booked re-run path).
  await setStatus(db, request.id, { status: 'booked', last_error: null, glofox_booking_id: bookingId })
  try {
    await maybeSendBookingWhatsappConfirm({ db, locationId: request.location_id, contact, templateName: CLASS_CONFIRM_TEMPLATE, bodyParams: [firstName, request.class_name || 'your class', classLabel(request.starts_at)] })
  } catch (e) { logWarn('cbp', 'class confirm failed', { err: e }) }
  // CTWA attribution: a confirmed booking is the conversion the ad campaign
  // optimises on. No-ops unless the contact carries a ctwa_clid and the
  // location has settings.meta_ads.dataset_id.
  try {
    await sendCtwaConversion(db, { locationId: request.location_id, contactId: request.contact_id, eventName: 'Schedule', contentName: request.class_name || 'Class' })
  } catch (e) { logWarn('cbp', 'ctwa conversion failed', { err: e }) }
  // Website Schedule for non-CTWA contacts (the /start funnel). CTWA contacts
  // are covered by the business_messaging event above — don't double-fire the
  // same booking down both channels.
  try {
    if (!contact.ctwa_clid) {
      await sendWebsiteConversion(db, {
        locationId: request.location_id, eventName: 'Schedule',
        email: contact.email, phone: contact.phone,
        eventSourceUrl: 'https://www.un1tdublin.com/start',
        eventId: `classbooking-${request.id}`,
        contentName: request.class_name || 'Class',
      })
    }
  } catch (e) { logWarn('cbp', 'website conversion failed', { err: e }) }
  return { outcome: 'booked' }
}
