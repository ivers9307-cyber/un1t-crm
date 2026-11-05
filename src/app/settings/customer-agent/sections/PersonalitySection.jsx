'use client'

// MIASETTINGS.2c — Personality and voice: the agent's name, tone, extra rules
// and reasoning effort, then Mia's voices. The voices card has its own Save
// and its own permission (owners and managers, VOICEREPLY.1), so it sits
// outside the owner-only fieldset. The read-only note sits above the
// settings, not above the voices (managers can edit those).

import MiaVoicesCard from '@/components/settings/MiaVoicesCard'
import { CARD } from './field-renderer'

export default function PersonalitySection({ renderField, canEdit, canEditVoices, readOnlyNote = null }) {
  return (
    <>
      {readOnlyNote}
      <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0">
        <section className={`space-y-5 ${CARD}`}>
          {renderField('agent_name')}
          {renderField('tone')}
          {renderField('extra_rules')}
          {/* MIA-HYGIENE.1 — reasoning effort, read live by the agent. */}
          {renderField('effort')}
        </section>
      </fieldset>
      <div data-testid="mia-voices">
        <MiaVoicesCard canEdit={canEditVoices} />
      </div>
    </>
  )
}
