'use client'

import { useState } from 'react'
import { Plus, Mail, MessageSquare } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import SequencePicker from './SequencePicker'

// SMS char-counter helper — single-segment GSM7 fits 160 chars;
// concatenated multi-segment messages count 153 chars per segment
// (7 chars per segment lost to UDH for the segment-id header).
function smsSegmentInfo(text) {
  const len = text.length
  if (len === 0) return { len: 0, segments: 0, perSegment: 160 }
  if (len <= 160) return { len, segments: 1, perSegment: 160 }
  return { len, segments: Math.ceil(len / 153), perSegment: 153 }
}

export default function ContactActions({ contactId, locationId, canSms = false, hasPhone = false, smsBlocked = false }) {
  const [showForm, setShowForm] = useState(null) // 'note' | 'activity' | 'sequence' | 'sms' | null
  const [saving, setSaving] = useState(false)
  const [smsBody, setSmsBody] = useState('')
  const [smsError, setSmsError] = useState(null)
  const router = useRouter()
  const db = createBrowserClient()
  const segInfo = smsSegmentInfo(smsBody)

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

  async function sendSms(e) {
    e.preventDefault()
    setSmsError(null)
    if (!smsBody.trim()) {
      setSmsError('Body cannot be empty')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/contacts/${contactId}/sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: smsBody }),
      })
      const data = await res.json()
      if (!data.success) {
        setSmsError(data.error || 'Failed to send SMS')
        setSaving(false)
        return
      }
      setSmsBody('')
      setShowForm(null)
      router.refresh()
    } catch (err) {
      setSmsError(err?.message || 'Failed to send SMS')
    } finally {
      setSaving(false)
    }
  }

  // SMS button visibility: gated by the 'sms' permission AND the
  // contact actually having a phone we can send to. smsBlocked is
  // true when the contact has opted out / is marked invalid — we
  // still render the button but disable it with a tooltip explaining
  // why, so admins know the feature exists.
  const showSmsButton = canSms

  return (
    <div className="relative">
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setShowForm(showForm === 'note' ? null : 'note')}
          className="text-xs px-2.5 py-1 rounded border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-mid flex items-center gap-1">
          <Plus size={12} /> Note
        </button>
        <button onClick={() => setShowForm(showForm === 'activity' ? null : 'activity')}
          className="text-xs px-2.5 py-1 rounded border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-mid flex items-center gap-1">
          <Plus size={12} /> Activity
        </button>
        <button onClick={() => setShowForm(showForm === 'sequence' ? null : 'sequence')}
          className="text-xs px-2.5 py-1 rounded border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-mid flex items-center gap-1">
          <Mail size={12} /> Sequence
        </button>
        {showSmsButton && (
          <button
            onClick={() => setShowForm(showForm === 'sms' ? null : 'sms')}
            disabled={!hasPhone || smsBlocked}
            title={
              !hasPhone
                ? "Contact has no phone number on file"
                : smsBlocked
                  ? "Contact has opted out of SMS or the number is marked invalid"
                  : ''
            }
            className="text-xs px-2.5 py-1 rounded border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-mid flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-un1t-light disabled:hover:border-un1t-gray"
          >
            <MessageSquare size={12} /> SMS
          </button>
        )}
      </div>

      {showForm === 'note' && (
        <form onSubmit={addNote} className="absolute right-0 top-10 z-10 bg-un1t-dark border border-un1t-gray rounded-lg p-4 w-80 shadow-lg">
          <textarea name="content" rows={3} placeholder="Add a note..."
            className="w-full bg-un1t-black border border-un1t-gray rounded p-2 text-sm text-un1t-white placeholder:text-un1t-mid resize-none focus:outline-none focus:border-un1t-mid" />
          <div className="flex justify-end gap-2 mt-2">
            <button type="button" onClick={() => setShowForm(null)} className="text-xs text-un1t-light hover:text-un1t-white">Cancel</button>
            <button type="submit" disabled={saving}
              className="text-xs px-3 py-1 bg-un1t-white text-un1t-black rounded font-medium hover:bg-un1t-accent disabled:opacity-50">
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

      {showForm === 'sms' && (
        <form onSubmit={sendSms} className="absolute right-0 top-10 z-10 bg-un1t-dark border border-un1t-gray rounded-lg p-4 w-96 shadow-lg space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Send SMS</span>
            <span className="text-[10px] text-un1t-mid">Per-location sender ID applies</span>
          </div>
          <textarea
            value={smsBody}
            onChange={e => setSmsBody(e.target.value)}
            rows={4}
            placeholder="Hi {{first_name}}, ..."
            maxLength={1600}
            className="w-full bg-un1t-black border border-un1t-gray rounded p-2 text-sm text-un1t-white placeholder:text-un1t-mid resize-none focus:outline-none focus:border-un1t-mid"
          />
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-un1t-mid">
              Merge tags: <code className="text-un1t-light">{'{{first_name}}'}</code>, <code className="text-un1t-light">{'{{name}}'}</code>, <code className="text-un1t-light">{'{{location_name}}'}</code>
            </span>
            <span className={segInfo.segments > 1 ? 'text-amber-500' : 'text-un1t-light'}>
              {segInfo.len} chars · {segInfo.segments} segment{segInfo.segments === 1 ? '' : 's'}
            </span>
          </div>
          {smsError && (
            <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
              {smsError}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => { setShowForm(null); setSmsBody(''); setSmsError(null) }} className="text-xs text-un1t-light hover:text-un1t-white">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !smsBody.trim()}
              className="text-xs px-3 py-1 bg-un1t-white text-un1t-black rounded font-medium hover:bg-un1t-accent disabled:opacity-50"
            >
              {saving ? 'Sending…' : 'Send SMS'}
            </button>
          </div>
        </form>
      )}

      {showForm === 'activity' && (
        <form onSubmit={addActivity} className="absolute right-0 top-10 z-10 bg-un1t-dark border border-un1t-gray rounded-lg p-4 w-80 shadow-lg space-y-2">
          <input name="subject" placeholder="Follow up with lead" required
            className="w-full bg-un1t-black border border-un1t-gray rounded px-2 py-1.5 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid" />
          <select name="type"
            className="w-full bg-un1t-black border border-un1t-gray rounded px-2 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid">
            <option value="call">Call</option>
            <option value="email">Email</option>
            <option value="meeting">Meeting</option>
            <option value="task">Task</option>
          </select>
          <div className="flex gap-2">
            <input name="due_date" type="date"
              className="flex-1 bg-un1t-black border border-un1t-gray rounded px-2 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid" />
            <input name="due_time" type="time"
              className="w-28 bg-un1t-black border border-un1t-gray rounded px-2 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid" />
          </div>
          <textarea name="note" rows={2} placeholder="Optional note..."
            className="w-full bg-un1t-black border border-un1t-gray rounded p-2 text-sm text-un1t-white placeholder:text-un1t-mid resize-none focus:outline-none focus:border-un1t-mid" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(null)} className="text-xs text-un1t-light hover:text-un1t-white">Cancel</button>
            <button type="submit" disabled={saving}
              className="text-xs px-3 py-1 bg-un1t-white text-un1t-black rounded font-medium hover:bg-un1t-accent disabled:opacity-50">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
