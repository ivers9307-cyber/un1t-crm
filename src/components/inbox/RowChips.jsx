// INBOXFOLLOW.1 — what a queue row says about time: how long the customer has
// waited on us (or we on them), when the WhatsApp reply window closes, and why
// a thread is where it is. The words come from shared/inbox-row-text.js (the
// phone renders the same ones); this file only dresses them in chips. The
// caller passes the clock (`nowMs`), the studio's follow-up config (`cfg`) and
// the studio's zone for clock times.

import {
  durationLabel, waitChipInfo, windowChipInfo, stateLineText,
} from '@shared/inbox-row-text'

export { durationLabel, stateLineText }

const CHIP = 'inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium'

const TONE = {
  amber: 'bg-amber-500/10 text-amber-700',
  slate: 'bg-slate-500/10 text-slate-700',
  gray: 'bg-gray-500/10 text-gray-700',
  emerald: 'bg-emerald-500/10 text-emerald-700',
}

// "waiting 2h 10m" when it is our turn; "quiet 2 days" when it is the customer's.
export function WaitChip({ conv, nowMs, cfg }) {
  const info = waitChipInfo(conv, nowMs, cfg)
  if (!info) return null
  return <span data-testid="wait-chip" className={`${CHIP} ${TONE[info.tone]}`}>{info.text}</span>
}

// "closes in 3h" (amber when it closes soon) or "template only". WhatsApp only.
export function WindowChip({ conv, nowMs }) {
  const info = windowChipInfo(conv, nowMs)
  if (!info) return null
  return <span data-testid="window-chip" className={`${CHIP} ${TONE[info.tone]}`}>{info.text}</span>
}

export function StateLine({ conv, nowMs, cfg, zone }) {
  const text = stateLineText({ conv, nowMs, cfg, zone })
  if (!text) return null
  return <span data-testid="state-line" className="text-xs text-un1t-muted truncate">{text}</span>
}
