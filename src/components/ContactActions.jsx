'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { useRouter } from 'next/navigation'

export default function ContactActions({ contactId }) {
  const [showForm, setShowForm] = useState(null) // 'note' | 'activity' | null
  const [saving, setSaving] = useState(false)
  const router = useRouter()
  const db = createBrowserClient()

  async function addNote(e) {
    e.preventDefault()
    setSaving(true)
    const content = e.target.content.value.trim()
    if (!content) return
    await db.from('notes').insert({ contact_id: contactId, content })
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
      due_date: fd.get('due_date') || null,
      due_time: fd.get('due_time') || null,
      note: fd.get('note') || null,
    })
    setSaving(false)
    setShowForm(null)
    router.refresh()
  }

  return (
    <div className="relative">
      <div className="flex gap-2">
        <button onClick={() => setShowForm(showForm === 'note' ? null : 'note')}
          className="text-xs px-2.5 py-1 rounded border border-un1t-gray text-un1t-light hover:text-white hover:border-un1t-mid flex items-center gap-1">
          <Plus size={12} /> Note
        </button>
        <button onClick={() => setShowForm(showForm === 'activity' ? null : 'activity')}
          className="text-xs px-2.5 py-1 rounded border border-un1t-gray text-un1t-light hover:text-white hover:border-un1t-mid flex items-center gap-1">
          <Plus size={12} /> Activity
        </button>
      </div>

      {showForm === 'note' && (
        <form onSubmit={addNote} className="absolute right-0 top-10 z-10 bg-un1t-dark border border-un1t-gray rounded-lg p-4 w-80 shadow-lg">
          <textarea name="content" rows={3} placeholder="Add a note..."
            className="w-full bg-un1t-black border border-un1t-gray rounded p-2 text-sm text-white placeholder:text-un1t-mid resize-none focus:outline-none focus:border-un1t-mid" />
          <div className="flex justify-end gap-2 mt-2">
            <button type="button" onClick={() => setShowForm(null)} className="text-xs text-un1t-light hover:text-white">Cancel</button>
            <button type="submit" disabled={saving}
              className="text-xs px-3 py-1 bg-white text-black rounded font-medium hover:bg-un1t-accent disabled:opacity-50">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      )}

      {showForm === 'activity' && (
        <form onSubmit={addActivity} className="absolute right-0 top-10 z-10 bg-un1t-dark border border-un1t-gray rounded-lg p-4 w-80 shadow-lg space-y-2">
          <input name="subject" placeholder="Follow up with lead" required
            className="w-full bg-un1t-black border border-un1t-gray rounded px-2 py-1.5 text-sm text-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid" />
          <select name="type"
            className="w-full bg-un1t-black border border-un1t-gray rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-un1t-mid">
            <option value="call">Call</option>
            <option value="email">Email</option>
            <option value="meeting">Meeting</option>
            <option value="task">Task</option>
          </select>
          <div className="flex gap-2">
            <input name="due_date" type="date"
              className="flex-1 bg-un1t-black border border-un1t-gray rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-un1t-mid" />
            <input name="due_time" type="time"
              className="w-28 bg-un1t-black border border-un1t-gray rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-un1t-mid" />
          </div>
          <textarea name="note" rows={2} placeholder="Optional note..."
            className="w-full bg-un1t-black border border-un1t-gray rounded p-2 text-sm text-white placeholder:text-un1t-mid resize-none focus:outline-none focus:border-un1t-mid" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(null)} className="text-xs text-un1t-light hover:text-white">Cancel</button>
            <button type="submit" disabled={saving}
              className="text-xs px-3 py-1 bg-white text-black rounded font-medium hover:bg-un1t-accent disabled:opacity-50">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
