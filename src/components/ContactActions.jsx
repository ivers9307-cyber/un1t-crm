'use client'

import { useState } from 'react'
import { Plus, Mail } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import SequencePicker from './SequencePicker'

// Per-contact quick actions: add a note, log an activity, or enrol the
// contact in a sequence.
//
// Messaging (WhatsApp + SMS) moved to ContactComposer in
// CONTACT-COMPOSER.1 — the unified, window-aware "Message this
// customer" box — so it's no longer duplicated here.
export default function ContactActions({ contactId, locationId }) {
  const [showForm, setShowForm] = useState(null) // 'note' | 'activity' | 'sequence' | null
  const [saving, setSaving] = useState(false)
  const router = useRouter()
  const db = createBrowserClient()

  async function addNote(e) {
    e.preventDefault()
    setSaving(true)
    const content = e.target.content.value.trim()
    if (!content) return
    await db.from('notes').insert({ contact_id: contactId, content, location_id: locationId })
    setSaving(false)
    setShowForm(null)
    router.refresh()
  }

  async function addActivity(e) {
    e.preventDefault()
    setSaving(true)
    const fd = new FormData(e.target)
    await db.from('activities').insert({
      contact_id: contactId,
      subject: fd.get('subject'),
      type: fd.get('type') || 'call',
      kind: 'task',  // mig 073 — manual form always creates a task
      due_date: fd.get('due_date') || null,
      due_time: fd.get('due_time') || null,
      note: fd.get('note') || null,
      location_id: locationId,
    })
    setSaving(false)
    setShowForm(null)
    router.refresh()
  }

  return (
    <div className="relative">
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setShowForm(showForm === 'note' ? null : 'note')}
          className="text-xs px-2.5 py-1 rounded border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-muted flex items-center gap-1">
          <Plus size={12} /> Note
        </button>
        <button onClick={() => setShowForm(showForm === 'activity' ? null : 'activity')}
          className="text-xs px-2.5 py-1 rounded border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-muted flex items-center gap-1">
          <Plus size={12} /> Activity
        </button>
        <button onClick={() => setShowForm(showForm === 'sequence' ? null : 'sequence')}
          className="text-xs px-2.5 py-1 rounded border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-muted flex items-center gap-1">
          <Mail size={12} /> Sequence
        </button>
      </div>

      {showForm === 'note' && (
        <form onSubmit={addNote} className="absolute right-0 top-10 z-10 bg-un1t-surface border border-un1t-border rounded-lg p-4 w-80 shadow-lg">
          <textarea name="content" rows={3} placeholder="Add a note..."
            className="w-full bg-un1t-bg border border-un1t-border rounded p-2 text-sm text-un1t-text placeholder:text-un1t-muted resize-none focus:outline-none focus:border-un1t-muted" />
          <div className="flex justify-end gap-2 mt-2">
            <button type="button" onClick={() => setShowForm(null)} className="text-xs text-un1t-subtle hover:text-un1t-text">Cancel</button>
            <button type="submit" disabled={saving}
              className="text-xs px-3 py-1 bg-un1t-text text-un1t-bg rounded font-medium hover:bg-un1t-accent disabled:opacity-50">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      )}

      {showForm === 'sequence' && (
        <div className="absolute right-0 top-10 z-10">
          <SequencePicker
            contactIds={[contactId]}
            locationId={locationId}
            variant="popover"
            onClose={() => setShowForm(null)}
          />
        </div>
      )}

      {showForm === 'activity' && (
        <form onSubmit={addActivity} className="absolute right-0 top-10 z-10 bg-un1t-surface border border-un1t-border rounded-lg p-4 w-80 shadow-lg space-y-2">
          <input name="subject" placeholder="Follow up with lead" required
            className="w-full bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted" />
          <select name="type"
            className="w-full bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted">
            <option value="call">Call</option>
            <option value="email">Email</option>
            <option value="meeting">Meeting</option>
            <option value="task">Task</option>
          </select>
          <div className="flex gap-2">
            <input name="due_date" type="date"
              className="flex-1 bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted" />
            <input name="due_time" type="time"
              className="w-28 bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted" />
          </div>
          <textarea name="note" rows={2} placeholder="Optional note..."
            className="w-full bg-un1t-bg border border-un1t-border rounded p-2 text-sm text-un1t-text placeholder:text-un1t-muted resize-none focus:outline-none focus:border-un1t-muted" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(null)} className="text-xs text-un1t-subtle hover:text-un1t-text">Cancel</button>
            <button type="submit" disabled={saving}
              className="text-xs px-3 py-1 bg-un1t-text text-un1t-bg rounded font-medium hover:bg-un1t-accent disabled:opacity-50">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
