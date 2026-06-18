'use client'

import { useState } from 'react'

const CATEGORIES = ['cardio', 'strength', 'conditioning']

export default function ClassCategoriesManager({ locationId, initialSeen }) {
  const [rows, setRows] = useState(initialSeen || [])
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState(null)

  function setCategory(className, category) {
    setRows((prev) => prev.map((r) => (r.class_name === className ? { ...r, category: category || null } : r)))
  }

  async function save() {
    setSaving(true); setError(null)
    try {
      const res = await fetch('/api/settings/class-categories', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, entries: rows.map((r) => ({ class_name: r.class_name, category: r.category })) }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || 'Save failed')
      setSavedAt(Date.now())
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (rows.length === 0) {
    return <p className="text-sm text-un1t-subtle">No classes detected yet. Once the bridge sees classes (or Glofox occurrences sync), they&apos;ll appear here to tag.</p>
  }

  return (
    <div>
      <ul className="divide-y divide-un1t-border rounded-2xl border border-un1t-border bg-white">
        {rows.map((r) => (
          <li key={r.class_name} className="flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.class_name}</span>
            <div className="flex items-center gap-1.5">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(r.class_name, r.category === c ? null : c)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${r.category === c ? 'bg-un1t-accent text-white' : 'border border-un1t-border text-un1t-subtle hover:bg-un1t-surface'}`}
                >
                  {c}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-un1t-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save categories'}
        </button>
        {savedAt && !saving && <span className="text-xs text-emerald-700">Saved</span>}
      </div>
    </div>
  )
}
