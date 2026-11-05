'use client'

// MIASETTINGS.2c — Knowledge: the facts the agent answers from, moved from
// CustomerAgentClient as it was. Each entry saves as you go (on blur, or on a
// change of category or on/off), behind /api/agent/knowledge, so it keeps its
// own state and is outside the owner-only rule: any manager+ can edit it. A
// failed knowledge read never counts as a failed settings read.

import { useState, useEffect } from 'react'
import { CARD, inputCls } from './field-renderer'
import { filterKnowledge } from '../knowledge-filter'

const CATEGORIES = ['sales', 'account', 'pause', 'cancellation', 'hours', 'general', 'faq']

export default function KnowledgeSection({ onCountChange } = {}) {
  const [entries, setEntries] = useState([])
  const [error, setError] = useState(null)
  const [importing, setImporting] = useState(false)
  const [importNote, setImportNote] = useState(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')

  useEffect(() => { onCountChange?.(entries.length) }, [entries.length]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const k = await fetch('/api/agent/knowledge').then(r => r.json())
        if (!cancelled && k?.success) setEntries(k.entries || [])
      } catch { /* the list stays as it was */ }
    })()
    return () => { cancelled = true }
  }, [])

  // KNOWLEDGE-IMPORT.1 — one click pulls the Glofox timetable's class
  // types + descriptions into knowledge. Existing titles are never
  // overwritten, so re-running after adding a class is safe.
  async function importFromGlofox() {
    setImporting(true); setError(null); setImportNote(null)
    try {
      const res = await fetch('/api/agent/knowledge/import-classes', { method: 'POST' })
      const j = await res.json()
      if (!j.success) { setError(j.error || 'Import failed'); return }
      if (j.imported?.length) setEntries(e => [...e, ...j.imported])
      const bits = []
      bits.push(`${j.imported?.length || 0} class${(j.imported?.length || 0) === 1 ? '' : 'es'} imported`)
      if (j.skipped?.length) bits.push(`${j.skipped.length} already in knowledge`)
      if (j.missing_description?.length) bits.push(`no Glofox description for: ${j.missing_description.join(', ')} (added as drafts, fill them in below)`)
      setImportNote(j.message || bits.join(' · '))
    } catch { setError('Import failed') } finally { setImporting(false) }
  }

  async function addEntry() {
    setError(null)
    try {
      const res = await fetch('/api/agent/knowledge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: 'sales', title: 'New entry', content: '', enabled: true }),
      })
      const j = await res.json()
      if (j.success) setEntries(e => [...e, j.entry])
      else setError(j.error || 'Could not add the entry')
    } catch { setError('Could not add the entry') }
  }
  function editLocal(id, patch) {
    setEntries(e => e.map(x => x.id === id ? { ...x, ...patch } : x))
  }
  async function persist(id, patch) {
    editLocal(id, patch)
    try {
      const res = await fetch(`/api/agent/knowledge/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      const j = await res.json()
      if (!j.success) setError(j.error || 'Could not save the entry')
    } catch { setError('Could not save the entry') }
  }
  async function deleteEntry(id) {
    setEntries(e => e.filter(x => x.id !== id))
    await fetch(`/api/agent/knowledge/${id}`, { method: 'DELETE' })
  }

  const shown = filterKnowledge(entries, { query, category })

  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <p className="text-sm text-un1t-muted">
          The facts the agent is allowed to use: prices, offers, policies, FAQs. If it isn&apos;t here,
          the agent hands off instead of guessing.
        </p>
        <div className="flex items-center gap-2">
          <button type="button" onClick={importFromGlofox} disabled={importing}
            className="text-sm border border-un1t-border rounded-md px-3 py-1.5 text-un1t-text hover:bg-un1t-bg disabled:opacity-50">
            {importing ? 'Importing…' : 'Import classes from Glofox'}
          </button>
          <button type="button" onClick={addEntry}
            className="text-sm border border-un1t-border rounded-md px-3 py-1.5 text-un1t-text hover:bg-un1t-bg">
            + Add entry
          </button>
        </div>
      </div>
      {error && <p className="text-sm text-red-600 mb-3" role="alert">{error}</p>}
      {importNote && <p className="text-sm text-emerald-700 mb-3">{importNote}</p>}

      {entries.length === 0 && (
        <div className="text-sm text-un1t-muted border border-dashed border-un1t-border rounded-md p-4">
          No knowledge yet. Add your prices, trial offer, opening hours, and common questions.
        </div>
      )}

      {/* MIASETTINGS.3c — outside any disabled fieldset: knowledge is editable by any manager. */}
      {entries.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          <input type="search" aria-label="Search knowledge" className={`${inputCls} sm:col-span-2`}
            placeholder="Search titles and answers" value={query} onChange={e => setQuery(e.target.value)} />
          <select aria-label="Category" className={inputCls} value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      )}
      {entries.length > 0 && shown.length === 0 && (
        <p className="text-sm text-un1t-muted border border-dashed border-un1t-border rounded-md p-4">No entries match.</p>
      )}

      <div className="space-y-3">
        {shown.map(entry => (
          <div key={entry.id} className="border border-un1t-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <select value={entry.category}
                onChange={e => persist(entry.id, { category: e.target.value })}
                className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-xs text-un1t-text">
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <input className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-sm text-un1t-text"
                value={entry.title}
                onChange={e => editLocal(entry.id, { title: e.target.value })}
                onBlur={e => persist(entry.id, { title: e.target.value })}
                placeholder="Short title" maxLength={200} />
              <label className="flex items-center gap-1 text-xs text-un1t-muted">
                <input type="checkbox" checked={!!entry.enabled}
                  onChange={e => persist(entry.id, { enabled: e.target.checked })} />
                on
              </label>
              <button type="button" onClick={() => deleteEntry(entry.id)}
                className="text-xs text-red-600 hover:underline">Delete</button>
            </div>
            <textarea className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              rows={2} maxLength={4000} value={entry.content}
              onChange={e => editLocal(entry.id, { content: e.target.value })}
              onBlur={e => persist(entry.id, { content: e.target.value })}
              placeholder="The answer / fact, in plain language." />
          </div>
        ))}
      </div>
    </section>
  )
}
