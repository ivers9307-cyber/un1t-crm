'use client'

// CONTACTTAGS.1 — the profile's Tags card.
//
// Two stores, shown apart on purpose:
//   • Manual tags (contacts.tags): removable chips plus an inline "Add tag"
//     box, for viewers who may edit the contact (the page's
//     contactActionGates(...).admin.canEdit, the same gate as the Edit button).
//     Saved through PUT /api/contacts/[id] with the whole new array, exactly
//     like the edit form, so the route's tag_added sequence triggers fire.
//   • Automatic tags (active contact_tags rows): read-only, dashed outline,
//     each with a title saying where it came from. The page passes only named
//     fields (tag, addedAt, description), never the rows.
import { useState } from 'react'
import { Tag, X, Plus } from 'lucide-react'
import { normaliseManualTag, manualTagProblem, applyManualTagChange } from '@/lib/contact-manual-tags'

const AUTO_TITLE = 'Set automatically by the CRM from what this person has done (bookings, payments, sign-ups). It cannot be edited here.'

export default function ContactTagsCard({ contactId, initialTags = [], machineTags = [], canEdit = false }) {
  const [tags, setTags] = useState(() => (Array.isArray(initialTags) ? initialTags : []))
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function save(nextTags) {
    setSaving(true)
    setError(null)
    try {
      const r = await fetch(`/api/contacts/${contactId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: nextTags }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setError(j.error || `Could not save the tags (${r.status})`)
        return false
      }
      setTags(Array.isArray(j.data?.tags) ? j.data.tags : nextTags)
      return true
    } catch {
      setError('Could not save the tags. Check your connection and try again.')
      return false
    } finally {
      setSaving(false)
    }
  }

  async function add(e) {
    e.preventDefault()
    const tag = normaliseManualTag(draft)
    const problem = manualTagProblem(tag)
    if (problem) { setError(problem); return }
    const change = applyManualTagChange(tags, tag, 'add')
    if (change.tooMany) { setError('A contact can carry at most 50 tags.'); return }
    if (!change.changed) { setDraft(''); setError(null); return }
    if (await save(change.next)) setDraft('')
  }

  async function remove(tag) {
    const change = applyManualTagChange(tags, tag, 'remove')
    if (change.changed) await save(change.next)
  }

  const hasAny = tags.length > 0 || machineTags.length > 0

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3" data-testid="contact-tags-card">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle flex items-center gap-1.5">
        <Tag size={12} /> Tags
      </h3>

      {!hasAny && !canEdit && <p className="text-sm text-un1t-muted">No tags</p>}

      {(tags.length > 0 || canEdit) && (
        <div>
          <p className="text-[11px] text-un1t-muted mb-1.5">Added by staff</p>
          <ul className="flex flex-wrap gap-1.5" aria-label="Manual tags">
            {tags.length === 0 && <li className="text-sm text-un1t-muted">None yet</li>}
            {tags.map((t) => (
              <li key={t} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-700">
                <span>{t}</span>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => remove(t)}
                    disabled={saving}
                    className="hover:text-un1t-text disabled:opacity-50"
                    aria-label={`Remove tag ${t}`}
                    title="Remove tag"
                  >
                    <X size={11} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canEdit && (
            <form onSubmit={add} className="flex items-center gap-1.5 mt-2">
              <label htmlFor={`add-tag-${contactId}`} className="sr-only">Add tag</label>
              <input
                id={`add-tag-${contactId}`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Add tag"
                maxLength={64}
                disabled={saving}
                className="flex-1 min-w-0 text-sm px-2 py-1 rounded-md border border-un1t-border bg-un1t-bg text-un1t-text placeholder:text-un1t-muted"
              />
              <button
                type="submit"
                disabled={saving || !draft.trim()}
                className="text-xs px-2 py-1 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-50 flex items-center gap-1"
              >
                <Plus size={12} /> Add
              </button>
            </form>
          )}
        </div>
      )}

      {machineTags.length > 0 && (
        <div>
          <p className="text-[11px] text-un1t-muted mb-1.5" title={AUTO_TITLE}>Set automatically</p>
          <ul className="flex flex-wrap gap-1.5" aria-label="Automatic tags">
            {machineTags.map((m) => (
              <li
                key={m.tag}
                className="text-xs px-2 py-0.5 rounded-full border border-dashed border-un1t-border text-un1t-subtle"
                title={m.description ? `${m.description} Set automatically; not editable here.` : AUTO_TITLE}
              >
                {m.tag}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </div>
  )
}
