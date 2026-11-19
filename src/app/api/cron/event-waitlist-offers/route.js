// EVENT-WAITLIST.1 — the waitlist offer round (mig 713), every 10 minutes.
//
// For every event with people waiting: rows of a past event expire; an event
// that is published, open for registration and has room in any time offers
// everyone not offered in the last 24 h at once (email always, WhatsApp when
// the location has an APPROVED offer template: the one it picked for the
// 'event_waitlist_offer' purpose, else one named `event_waitlist_offer`). The first to
// complete a booking gets the place: the register route is the arbiter.
// src/lib/event-waitlist.js runWaitlistOffers.
//
// Stamps its heartbeat on every completed run (a run with nothing to offer is
// healthy). Per-row send failures are counts in the outcome, never a missed
// stamp; only a run that could not read the list throws, returns 500 and
// leaves the row to go stale.
import { runWaitlistOffers } from '@/lib/event-waitlist'
import { defineCron } from '@/lib/define-cron'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'event-waitlist-offers' }, async ({ db }) => {
  const data = await runWaitlistOffers(db)
  return { body: { data }, outcome: data }
})
