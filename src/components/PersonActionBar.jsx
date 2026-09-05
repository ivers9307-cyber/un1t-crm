'use client'

// PERSON-ACTIONS.1 — the reusable per-contact action affordance:
// Message / Task / Sequence behind one consistent control. The audit
// flagged ~10 divergent per-person entry points; this collapses the
// generic ones into a single component so a pipeline card, a contact
// header, etc. all offer the same actions the same way.
//
// Generalised out of DealCard's bespoke 3-dots-menu + centred-modal
// machinery (which only offered "Add to sequence"). Renders a kebab
// trigger → dropdown of actions; Task + Sequence open in a fixed,
// centred overlay (a popover spills past a 256px kanban column and
// gets clipped — the same reason DealCard used a centred modal), and
// Message deep-links to the contact's window-aware composer
// (`/contacts/[id]#message`).
//
// Self-contains stopPropagation on every handler so it's safe to drop
// inside a clickable parent (e.g. a kanban card whose body navigates).

import { useRouter } from 'next/navigation'
import { useState, useRef, useEffect } from 'react'
import { MoreVertical, MessageSquare, CheckSquare, Repeat, Snowflake, RotateCcw, FileX } from 'lucide-react'
import dynamic from 'next/dynamic'
import { createBrowserClient } from '@/lib/supabase'

// SequencePicker is heavy + only needed once the operator opens an
// action — lazy-load it (mirrors the DealCard PERF.3 note).
const SequencePicker = dynamic(() => import('./SequencePicker'), { ssr: false })
// CANCEL-FORM.4 — same reason: only loaded once the operator opens it.
const SendCancellationFormModal = dynamic(() => import('./SendCancellationFormModal'), { ssr: false })

const ACTION_DEFS = {
  message: { label: 'Message', icon: MessageSquare },
  task: { label: 'Task', icon: CheckSquare },
  sequence: { label: 'Sequence', icon: Repeat },
  // FUNNEL.4 — label/icon are dynamic (see renderColdItem); this entry just
  // keeps 'cold' a recognised action so callers can opt in via `actions`.
  cold: { label: 'Cold', icon: Snowflake },
  // CANCEL-FORM.4 — staff send the member a single-use pause/cancel form link.
  cancel_form: { label: 'Send cancellation form', icon: FileX },
}

export default function PersonActionBar({
  contactId,
  locationId,
  actions = ['message', 'task', 'sequence'],
  // FUNNEL.4 — when the 'cold' action is enabled, this drives the toggle
  // label: true → "Return to pipeline" (clear), false → "Mark as Cold".
  isCold = false,
  align = 'right',
  className = '',
}) {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [overlay, setOverlay] = useState(null) // 'task' | 'sequence' | 'cancel_form' | null
  const [saving, setSaving] = useState(false)
  // Two refs — trigger + dropdown — so the outside-click handler skips
  // closing when the click lands in either (the DealCard v1 bug:
  // mousedown closed the menu before the item's click could fire).
  const buttonRef = useRef(null)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!menuOpen) return
    function onClick(e) {
      if (buttonRef.current?.contains(e.target)) return
      if (menuRef.current?.contains(e.target)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [menuOpen])

  function pick(action, e) {
    e?.stopPropagation()
    setMenuOpen(false)
    if (action === 'message') {
      // Deep-link to the contact's composer (anchored #message section).
      if (contactId) router.push(`/contacts/${contactId}#message`)
      return
    }
    if (action === 'cold') { toggleCold() ; return }
    setOverlay(action)
  }

  // FUNNEL.4 — mark Cold (off the pipeline) / return to the pipeline. The
  // classifier re-places the deal server-side; refresh to reflect it.
  async function toggleCold() {
    if (saving) return
    setSaving(true)
    try {
      const res = await fetch(`/api/contacts/${contactId}/pipeline-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cold: !isCold }),
      })
      if (!res.ok) {
        let msg = 'Could not update pipeline status'
        try { const j = await res.json(); msg = j.error || msg } catch { /* non-JSON */ }
        alert(msg)
        return
      }
      router.refresh()
    } catch {
      alert('Could not update pipeline status')
    } finally {
      setSaving(false)
    }
  }

  async function addTask(e) {
    e.preventDefault()
    e.stopPropagation()
    const fd = new FormData(e.target)
    const subject = (fd.get('subject') || '').toString().trim()
    if (!subject) return
    setSaving(true)
    const db = createBrowserClient()
    try {
      await db.from('activities').insert({
        contact_id: contactId,
        subject,
        type: fd.get('type') || 'call',
        kind: 'task', // manual form always creates a task (mig 073)
        due_date: fd.get('due_date') || null,
        due_time: fd.get('due_time') || null,
        note: fd.get('note') || null,
        location_id: locationId,
      })
    } finally {
      setSaving(false)
      setOverlay(null)
      router.refresh()
    }
  }

  const items = actions.filter((a) => ACTION_DEFS[a])
  if (!contactId || items.length === 0) return null

  return (
    <div className={`relative ${className}`} onClick={(e) => e.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o) }}
        className="shrink-0 text-un1t-subtle hover:text-un1t-text p-0.5 -m-0.5 rounded"
        title="Actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <MoreVertical size={14} />
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-7 z-20 bg-un1t-surface border border-un1t-border rounded-md shadow-lg py-1 min-w-[150px]`}
        >
          {items.map((a) => {
            // FUNNEL.4 — the Cold toggle: dynamic label + icon, and a subtle
            // divider above it since it's a state change, not a compose action.
            if (a === 'cold') {
              const Icon = isCold ? RotateCcw : Snowflake
              const label = isCold ? 'Return to pipeline' : 'Mark as Cold'
              return (
                <button
                  key={a}
                  type="button"
                  role="menuitem"
                  disabled={saving}
                  onClick={(e) => pick(a, e)}
                  className="w-full text-left px-3 py-1.5 text-xs text-un1t-text hover:bg-un1t-border/40 flex items-center gap-2 border-t border-un1t-border/60 disabled:opacity-50"
                >
                  <Icon size={13} className="text-un1t-subtle" /> {label}
                </button>
              )
            }
            const { label, icon: Icon } = ACTION_DEFS[a]
            return (
              <button
                key={a}
                type="button"
                role="menuitem"
                onClick={(e) => pick(a, e)}
                className="w-full text-left px-3 py-1.5 text-xs text-un1t-text hover:bg-un1t-border/40 flex items-center gap-2"
              >
                <Icon size={13} className="text-un1t-subtle" /> {label}
              </button>
            )
          })}
        </div>
      )}

      {/* Task overlay — fixed centred so it never clips inside a narrow
          column. */}
      {overlay === 'task' && (
        <Overlay onClose={() => setOverlay(null)}>
          <form
            onSubmit={addTask}
            onClick={(e) => e.stopPropagation()}
            className="bg-un1t-surface border border-un1t-border rounded-lg p-4 w-80 shadow-lg space-y-2"
          >
            <input
              name="subject"
              placeholder="Follow up with lead"
              required
              autoFocus
              className="w-full bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
            />
            <select
              name="type"
              className="w-full bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
            >
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="meeting">Meeting</option>
              <option value="task">Task</option>
            </select>
            <div className="flex gap-2">
              <input
                name="due_date"
                type="date"
                className="flex-1 bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
              />
              <input
                name="due_time"
                type="time"
                className="w-28 bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
              />
            </div>
            <textarea
              name="note"
              rows={2}
              placeholder="Optional note..."
              className="w-full bg-un1t-bg border border-un1t-border rounded p-2 text-sm text-un1t-text placeholder:text-un1t-muted resize-none focus:outline-none focus:border-un1t-muted"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setOverlay(null)} className="text-xs text-un1t-subtle hover:text-un1t-text">
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="text-xs px-3 py-1 bg-un1t-text text-un1t-bg rounded font-medium hover:bg-un1t-accent disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save task'}
              </button>
            </div>
          </form>
        </Overlay>
      )}

      {/* CANCEL-FORM.4 — send the cancellation form link */}
      {overlay === 'cancel_form' && (
        <Overlay onClose={() => setOverlay(null)}>
          <SendCancellationFormModal
            contactId={contactId}
            onClose={() => setOverlay(null)}
            onSent={() => router.refresh()}
          />
        </Overlay>
      )}

      {/* Sequence overlay */}
      {overlay === 'sequence' && (
        <Overlay onClose={() => setOverlay(null)}>
          <div onClick={(e) => e.stopPropagation()}>
            <SequencePicker
              contactIds={[contactId]}
              locationId={locationId}
              variant="modal"
              onClose={() => setOverlay(null)}
            />
          </div>
        </Overlay>
      )}
    </div>
  )
}

// Fixed, centred overlay floating above everything regardless of the
// host layout's width/clipping. Click outside closes.
function Overlay({ children, onClose }) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-24 px-4"
      onClick={onClose}
    >
      {children}
    </div>
  )
}
