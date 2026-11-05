'use client'

// MIASETTINGS.2c — Messages: every customer-facing message Mia or the system
// sends, in the registry's groups (MESSAGE_GROUPS), each with its heading. A
// group with nothing to show here is left out: the WhatsApp booking form
// message is Hatch only at the studio, and so is the whole Payments at Hatch
// group (MIAHATCH.4: a Glofox studio never says any of it). Placeholders are
// the code defaults. A plain list for now; MIASETTINGS.4 folds and searches it.

import { fieldsFor, MESSAGE_GROUPS } from '../fields'
import { CARD } from './field-renderer'

export default function MessagesSection({ agent, renderField, canEdit }) {
  const fields = fieldsFor('studio', 'messages', agent.ctx)
  const groups = MESSAGE_GROUPS
    .map((g) => ({ ...g, ids: fields.filter((f) => f.group === g.key).map((f) => f.id) }))
    .filter((g) => g.ids.length > 0)
  return (
    <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0">
      <section className={`space-y-6 ${CARD}`}>
        <p className="text-xs text-un1t-muted">Leave a message blank to use the default shown.</p>
        {groups.map((g) => (
          <div key={g.key} className="space-y-4"
            data-testid={g.key === 'hatch-payments' ? 'hatch-copy-group' : `message-group-${g.key}`}>
            <h3 className="text-sm font-semibold text-un1t-text">{g.title}</h3>
            {g.key === 'hatch-payments' && (
              <p className="text-xs text-un1t-muted">
                Messages customers get from Mia, and the two pages they land on after paying, at this studio.
              </p>
            )}
            {g.ids.map((id) => renderField(id))}
          </div>
        ))}
      </section>
    </fieldset>
  )
}
