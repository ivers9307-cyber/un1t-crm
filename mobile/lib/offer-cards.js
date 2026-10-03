// mobile/lib/offer-cards.js
//
// REPLACE.1b — what the phone's "Offer to team" surfaces SAY and DECIDE: the
// Dashboard card's lines, the alerts after offer / claim, and the Manage
// card's control. Pure (no React Native), vitest-tested beside it. The rule
// itself is shared/offer-to-team.js, the one the web and the route use.
import { offerRefusal, offerStateLabel, offerWhenLine, offerPostResultText, offerClaimResultText } from 'shared/offer-to-team'

const OFFLINE = "Couldn't reach the server. Check your connection and try again."

/** A Dashboard card's two lines: 'Morning · Studio North' and 'Tue 29 Sep · 06:00-07:00'. */
export function offerCardLines(offer) {
  return {
    title: [offer?.shift_name || 'Shift', offer?.studio_name].filter(Boolean).join(' · '),
    when: offerWhenLine(offer),
  }
}

/** The alert after claimShiftOffer (an api() envelope). */
export function offerClaimAlert(res) {
  if (res?.transport) return { title: "Couldn't claim", message: OFFLINE }
  const out = offerClaimResultText(res?.success ? 200 : (res?.status || 0), res)
  return { title: out.tone === 'success' ? 'Shift claimed' : "Couldn't claim", message: out.text }
}

/** The alert after offerBlockToTeam (an api() envelope). */
export function offerPostAlert(res) {
  if (res?.transport) return { title: "Couldn't offer", message: OFFLINE }
  const out = offerPostResultText(res?.success ? 201 : (res?.status || 0), res)
  return { title: out.tone === 'error' ? "Couldn't offer" : 'Offered to the team', message: out.text }
}

/** The Manage card's offer control: { kind: 'offer' } | { kind: 'offered', label } | null. */
export function blockOfferControl(block, offer, todayIso) {
  if (offer) return { kind: 'offered', label: offerStateLabel(offer) }
  return offerRefusal(block, { todayIso }) ? null : { kind: 'offer' }
}
