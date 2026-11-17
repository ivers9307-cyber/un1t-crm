'use client'

// CONTACTTAGS.1 — bulk Add tag / Remove tag from the contacts list's bulk bar.
// One tag, one action, POST /api/contacts/bulk-tags. The route answers counts
// only (updated / unchanged / skipped / failed), never which contacts it
// skipped, so the summary below says how many and nothing more.
import { useState } from 'react'
import { Modal, Button, Field } from '@/components/ui'
import { normaliseManualTag, manualTagProblem } from '@/lib/contact-manual-tags'

export function bulkTagSummary(action, d) {
  if (!d) return ''
  const parts = [`${d.updated} ${action === 'add' ? 'tagged' : 'untagged'}`]
  if (d.unchanged) parts.push(`${d.unchanged} ${action === 'add' ? 'already had it' : 'did not have it'}`)
  if (d.skipped) parts.push(`${d.skipped} skipped (not available to you at this studio)`)
  if (d.failed) parts.push(`${d.failed} could not be saved, try again`)
  return parts.join(' · ')
}

export default function ContactBulkTagModal({ action, contactIds, onClose, onDone }) {
  const [tag, setTag] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const verb = action === 'add' ? 'Add tag' : 'Remove tag'

  async function submit(e) {
    e?.preventDefault?.()
    const clean = normaliseManualTag(tag)
    const problem = manualTagProblem(clean)
    if (problem) { setError(problem); return }
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/contacts/bulk-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_ids: contactIds, tag: clean, action }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setError(j.error || `Could not ${action} the tag (${r.status})`)
        return
      }
      setResult(j.data)
      // The list shows no tags, so nothing on screen needs refreshing.
      onDone?.(j.data)
    } catch {
      setError('Could not reach the server. Nothing may have changed; try again.')
    } finally {
      setBusy(false)
    }
  }

  const footer = result ? (
    <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
  ) : (
    <>
      <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button type="submit" form="bulk-tag-form" variant={action === 'remove' ? 'danger' : 'primary'} loading={busy} disabled={!tag.trim()}>
        {verb}
      </Button>
    </>
  )

  return (
    <Modal open onClose={onClose} title={`${verb} · ${contactIds.length} selected`} footer={footer} size="sm">
      {result ? (
        <p className="text-sm text-un1t-text" role="status">{bulkTagSummary(action, result)}</p>
      ) : (
        <form id="bulk-tag-form" onSubmit={submit} className="space-y-3">
          <Field id="bulk-tag-input" label="Tag" hint={action === 'add' ? 'Added to each selected contact that does not have it yet.' : 'Removed from each selected contact that has it.'} error={error || undefined}>
            {(p) => (
              <input
                {...p}
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                maxLength={64}
                autoFocus
                className="w-full text-sm px-3 py-2 rounded-md border border-un1t-border bg-un1t-bg text-un1t-text"
              />
            )}
          </Field>
        </form>
      )}
    </Modal>
  )
}
