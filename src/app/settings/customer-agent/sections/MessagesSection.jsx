'use client'

// MIASETTINGS.2c / 3a — Messages: every customer-facing message Mia or the
// system sends, in the registry's groups (MESSAGE_GROUPS), each folded to a
// one-line preview and searchable. A group with nothing to show is left out:
// the WhatsApp booking form message is Hatch only at the studio, and so is
// the whole Payments at Hatch group (MIAHATCH.4). Placeholders are the code
// defaults. Search, "Changed only", group folds and row toggles sit outside
// the disabled fieldset, so a read-only viewer can browse; only an open row's
// field is disabled.

import { useState } from 'react'
import { valueAt } from '@/lib/agent/settings-overrides'
import { fieldsFor, MESSAGE_GROUPS } from '../fields'
import { filterMessages } from '../messages-filter'
import MessageRow from '../components/MessageRow'
import { CARD, inputCls } from './field-renderer'

export default function MessagesSection({ agent, canEdit }) {
  const { settings, overridden, ctx, setField, sourceTag } = agent
  const [query, setQuery] = useState('')
  const [changedOnly, setChangedOnly] = useState(false)
  const [openRows, setOpenRows] = useState(() => new Set())
  const [foldedGroups, setFoldedGroups] = useState(() => new Set())

  const all = fieldsFor('studio', 'messages', ctx)
  const shown = filterMessages(all, { query, changedOnly, settings, overridden, ctx })
  const groups = MESSAGE_GROUPS
    .map((g) => ({ ...g, fields: shown.filter((f) => f.group === g.key) }))
    .filter((g) => g.fields.length > 0)

  const flip = (setter, key) => setter((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  return (
    <section className={`space-y-6 ${CARD}`}>
      <p className="text-xs text-un1t-muted">Leave a message blank to use the default shown.</p>
      <div className="flex flex-wrap items-center gap-4">
        <input type="search" aria-label="Search messages" placeholder="Search messages"
          className={`${inputCls} max-w-xs`} value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-un1t-text">
          <input type="checkbox" className="h-4 w-4" checked={changedOnly}
            onChange={(e) => setChangedOnly(e.target.checked)} />
          Changed only
        </label>
      </div>
      {groups.length === 0 && <p className="text-sm text-un1t-muted">No messages match.</p>}
      {groups.map((g) => {
        const folded = foldedGroups.has(g.key)
        return (
          <div key={g.key} className="space-y-3"
            data-testid={g.key === 'hatch-payments' ? 'hatch-copy-group' : `message-group-${g.key}`}>
            <button type="button" aria-expanded={!folded} onClick={() => flip(setFoldedGroups, g.key)}
              className="text-sm font-semibold text-un1t-text">
              {g.title} ({g.fields.length})
            </button>
            {!folded && g.key === 'hatch-payments' && (
              <p className="text-xs text-un1t-muted">
                Messages customers get from Mia, and the two pages they land on after paying, at this studio.
              </p>
            )}
            {!folded && g.fields.map((f) => (
              <MessageRow key={f.id} field={f} ctx={ctx} value={valueAt(settings, f.paths[0])}
                tag={f.scope === 'both' ? sourceTag(f.paths) : undefined}
                open={openRows.has(f.id)} onToggle={() => flip(setOpenRows, f.id)}
                onChange={setField} disabled={!canEdit} />
            ))}
          </div>
        )
      })}
    </section>
  )
}
