'use client'

// Per-car notes timeline. Two kinds of entries:
//   - 'manual'  — operator-typed via the inline form below
//   - 'system'  — auto-generated (issue-deposit-link drops one with
//                 the link URL so it can be copied / re-tested later)
//
// Mounted in CarDetail above the BuyerCard so it's visible regardless
// of car status. Lazy-loads the notes list on mount.

import { useEffect, useState, useCallback } from 'react'
import { StickyNote, Plus, Trash2, Copy, Check, Sparkles, User } from 'lucide-react'

export default function NotesCard({ carId }) {
  const [notes, setNotes] = useState(null)
  const [content, setContent] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cars/${carId}/notes`)
      const j = await res.json()
      if (j.success) setNotes(j.notes || [])
      else setError(j.error || 'Failed to load notes')
    } catch (e) {
      setError(e.message || 'Network error')
    }
  }, [carId])
  useEffect(() => { load() }, [load])

  async function add(e) {
    e.preventDefault()
    if (!content.trim()) return
    setAdding(true); setError(null)
    try {
      const res = await fetch(`/api/cars/${carId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content.trim() }),
      })
      const j = await res.json()
      if (!j.success) {
        setError(j.error || 'Failed to add note')
        return
      }
      setNotes(prev => [j.note, ...(prev || [])])
      setContent('')
    } finally {
      setAdding(false)
    }
  }

  async function remove(noteId) {
    if (!confirm('Delete this note?')) return
    try {
      const res = await fetch(`/api/cars/${carId}/notes/${noteId}`, { method: 'DELETE' })
      const j = await res.json()
      if (!j.success) {
        alert(j.error || 'Failed to delete')
        return
      }
      setNotes(prev => (prev || []).filter(n => n.id !== noteId))
    } catch (e) {
      alert(e.message || 'Network error')
    }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle flex items-center gap-1.5">
          <StickyNote size={12} /> Notes
        </h3>
        {notes && notes.length > 0 && (
          <span className="text-[11px] text-un1t-muted">{notes.length} entr{notes.length === 1 ? 'y' : 'ies'}</span>
        )}
      </div>

      {/* Add form */}
      <form onSubmit={add} className="mb-3">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Add a note about this car…"
          rows={2}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted resize-y"
        />
        <div className="flex justify-end mt-2">
          <button
            type="submit"
            disabled={adding || !content.trim()}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent disabled:opacity-50"
          >
            <Plus size={11} /> {adding ? 'Adding…' : 'Add note'}
          </button>
        </div>
      </form>

      {error && (
        <p className="text-xs text-red-400 mb-3">{error}</p>
      )}

      {/* List */}
      <div className="space-y-2">
        {notes === null ? (
          <p className="text-xs text-un1t-subtle">Loading…</p>
        ) : notes.length === 0 ? (
          <p className="text-xs text-un1t-muted italic">No notes yet.</p>
        ) : (
          notes.map(n => <NoteRow key={n.id} note={n} onDelete={() => remove(n.id)} />)
        )}
      </div>
    </div>
  )
}

function NoteRow({ note, onDelete }) {
  const isSystem = note.kind === 'system'
  return (
    <div className={`p-3 rounded-md border text-sm ${
      isSystem
        ? 'bg-blue-500/5 border-blue-500/20'
        : 'bg-un1t-bg border-un1t-border'
    }`}>
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 text-[11px] text-un1t-subtle">
          {isSystem ? <Sparkles size={10} className="text-blue-400" /> : <User size={10} />}
          <span>{isSystem ? 'System' : (note.profiles?.full_name || 'Operator')}</span>
          <span className="text-un1t-muted">·</span>
          <span>{new Date(note.created_at).toLocaleString('en-IE')}</span>
        </div>
        <button
          onClick={onDelete}
          className="text-un1t-muted hover:text-red-400 p-0.5 -m-0.5"
          title="Delete note"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <NoteContent content={note.content} />
    </div>
  )
}

// Renders note content with any embedded URLs as copy/open links.
// System notes from the deposit-link issue flow contain a URL on its
// own line — surfacing it as a clickable affordance is the whole
// point of having the note.
function NoteContent({ content }) {
  const lines = content.split('\n')
  return (
    <div className="text-un1t-text whitespace-pre-wrap break-words text-sm">
      {lines.map((line, i) => {
        const urlMatch = line.match(/^(https?:\/\/\S+)(.*)$/)
        if (urlMatch) {
          return (
            <div key={i} className="flex items-center gap-2 my-1">
              <a
                href={urlMatch[1]}
                target="_blank"
                rel="noreferrer"
                className="text-blue-400 hover:underline truncate text-xs flex-1 min-w-0"
              >
                {urlMatch[1]}
              </a>
              <CopyButton value={urlMatch[1]} />
              {urlMatch[2] && (
                <span className="text-[11px] text-un1t-subtle">{urlMatch[2].trim()}</span>
              )}
            </div>
          )
        }
        return <div key={i}>{line || ' '}</div>
      })}
    </div>
  )
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }
  return (
    <button
      onClick={copy}
      className="text-un1t-subtle hover:text-un1t-text p-1 rounded shrink-0"
      title={copied ? 'Copied!' : 'Copy URL'}
    >
      {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
    </button>
  )
}
