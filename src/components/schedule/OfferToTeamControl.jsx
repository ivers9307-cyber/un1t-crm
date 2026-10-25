'use client'
// REPLACE.1b — the block dialog's "Offer to team" control. The rule is
// shared/offer-to-team.js (the same one the phone and the route use); the
// route has the last word on "started" (studio clock). Three states: a button
// when the shared rule allows an offer, the open offer's state + Withdraw,
// or nothing.
import { Megaphone } from 'lucide-react'
import { offerRefusal, offerStateLabel } from '@shared/offer-to-team'

export default function OfferToTeamControl({ block, offer = null, todayIso, busy = false, onOffer, onWithdraw }) {
  if (offer) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-un1t-border bg-un1t-surface px-3 py-2">
        <span className="text-xs text-un1t-text inline-flex items-center gap-1.5 min-w-0">
          <Megaphone size={12} aria-hidden="true" className="flex-shrink-0" />
          <span className="break-words">{offerStateLabel(offer)}</span>
        </span>
        <button
          type="button"
          onClick={onWithdraw}
          disabled={busy}
          className="text-[11px] text-un1t-subtle hover:text-red-700 disabled:opacity-50 px-2 py-1 rounded hover:bg-red-500/10"
        >
          Withdraw offer
        </button>
      </div>
    )
  }
  if (offerRefusal(block, { todayIso })) return null
  return (
    <button
      type="button"
      onClick={onOffer}
      disabled={busy}
      className="text-xs bg-un1t-surface text-un1t-text border border-un1t-border hover:border-un1t-text/40 disabled:opacity-50 px-3 py-2 rounded-md font-medium inline-flex items-center gap-1.5"
    >
      <Megaphone size={12} aria-hidden="true" /> Offer to team
    </button>
  )
}
