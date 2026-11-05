'use client'

// MIASETTINGS.2c — Handoffs: when the agent hands a chat to a human, when it
// comes back, and what the customer is told.

import { CARD } from './field-renderer'

export default function HandoffsSection({ renderField, canEdit }) {
  return (
    <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0">
      <section className={`space-y-5 ${CARD}`}>
        {renderField('handoff_cooldown_hours')}
        {/* MIA-BOARD.1 — auto-resolve. The manual Resolve was used exactly
            zero times in the feature's lifetime (121 parked threads at the
            25 Aug re-audit), so the queue now cleans itself. */}
        <div className="grid grid-cols-2 gap-3">
          {renderField('auto_resolve_after_reply_hours')}
          {renderField('auto_resolve_stale_hours')}
        </div>
        {/* MIA-HYGIENE.1 — the verify-fail handoff, bounded 1-5 so a typo
            can't disable the net. */}
        {renderField('handoff_after_verify_failures')}
        {renderField('holding_message')}
      </section>
    </fieldset>
  )
}
