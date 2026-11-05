'use client'

// MIASETTINGS.2d — the one save bar for Mia's studio settings. It shows how
// many unsaved changes there are, Discard and Save, any holds (each a button
// that opens the section to fix), the save error, and "Saved" for four
// seconds after a save. With nothing to say it is out of sight but still in
// the page (a keyboard user tabbing to it sees it), so Save with no edits
// keeps working.
//   count     unsaved changes (dirty.js changedFieldCount)
//   holds     [{ section, message }]
//   savedAt   ms epoch of the last good save, or null
//   saveLabel the Save button's text (default "Save")

import { useEffect, useState } from 'react'
import { SECTIONS } from '../sections'

const SAVED_MS = 4000
const LABELS = Object.fromEntries(SECTIONS.map((s) => [s.key, s.label]))

export default function SaveBar({
  count, holds = [], saving = false, savedAt = null, error = null,
  onSave, onDiscard, onGoTo, saveLabel = 'Save',
}) {
  const [showSaved, setShowSaved] = useState(false)
  useEffect(() => {
    if (!savedAt) { setShowSaved(false); return undefined }
    const left = SAVED_MS - (Date.now() - savedAt)
    if (left <= 0) { setShowSaved(false); return undefined }
    setShowSaved(true)
    const t = setTimeout(() => setShowSaved(false), left)
    return () => clearTimeout(t)
  }, [savedAt])

  const idle = count === 0 && !showSaved
  return (
    <div role="region" aria-label="Save settings"
      className={idle
        ? 'sr-only focus-within:not-sr-only focus-within:mt-6'
        : 'sticky bottom-0 mt-6 border border-un1t-border bg-un1t-surface rounded-lg px-4 py-3 shadow-sm'}>
      {error && <div className="text-sm text-red-600 mb-2" role="alert">{error}</div>}
      {holds.length > 0 && (
        <ul className="mb-2 space-y-1">
          {holds.map((h) => (
            <li key={`${h.section}:${h.message}`}>
              <button type="button" onClick={() => onGoTo?.(h.section)}
                className="text-sm text-amber-700 underline text-left">
                {`${h.message} in ${LABELS[h.section] || h.section}`}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {count > 0 && (
          <span className="text-sm text-un1t-text">{count === 1 ? '1 unsaved change' : `${count} unsaved changes`}</span>
        )}
        {count === 0 && showSaved && <span className="text-sm text-green-700">Saved</span>}
        <span className="flex-1" />
        {count > 0 && (
          <button type="button" onClick={onDiscard} disabled={saving}
            className="px-3 py-2 rounded-md text-sm text-un1t-muted hover:text-un1t-text disabled:opacity-50">
            Discard
          </button>
        )}
        <button type="button" onClick={onSave} disabled={saving || holds.length > 0}
          className="bg-un1t-text text-un1t-bg px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50">
          {saving ? 'Saving…' : saveLabel}
        </button>
      </div>
    </div>
  )
}
