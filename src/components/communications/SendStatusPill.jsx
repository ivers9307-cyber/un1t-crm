// COMMS-DETAIL-FIX.4 — the ONE status pill for every send-detail header.
//
// Email rendered a title-cased label from a private map, WhatsApp printed the
// raw lowercase DB value in a `bg-green-500/20` pill (below the readable ramp,
// and not the repo's `/10` recipe), and SMS rendered no status at all — so on
// SMS a sent, a cancelled and a scheduled broadcast looked identical.
//
// `testId` exists because CampaignDetail's status chip already had a test
// handle (`campaign-status-chip`) that guards the COMMSFIX.D.1a regression;
// moving the markup here must not move that guard's target.

import { sendStatusDisplay } from '@/lib/send-status-display'

export default function SendStatusPill({ status, title = undefined, testId = 'send-status-pill' }) {
  const d = sendStatusDisplay(status)
  if (!d) return null
  return (
    <span
      data-testid={testId}
      title={title || undefined}
      className={`inline-flex items-center whitespace-nowrap text-xs font-medium px-2 py-0.5 rounded-full ${d.cls}`}
    >
      {d.label}
    </span>
  )
}
