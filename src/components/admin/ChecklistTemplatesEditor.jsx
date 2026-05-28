// CHECKLIST.1 — interactive grid + drawer editor for checklist
// templates. Fetches the location's templates on mount, lays them
// out in a (role × day) grid, and lets master / owner click into
// any cell to edit (or create) the template for that pairing.
//
// All writes go through /api/checklists/templates[?id]. The grid
// re-fetches after each successful mutation so optimism stays
// honest.

'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, Edit3, Save, X, Trash2, Loader2, AlertCircle, GripVertical, CheckSquare, Square } from 'lucide-react'

const ROLES = ['staff', 'head_coach', 'manager', 'owner']
const ROLE_LABELS = {
  staff:      'Staff',
  head_coach: 'Head coach',
  manager:    'Manager',
  owner:      'Owner',
}
// Mon..Sun in display order (more natural for a weekday roster).
// Postgres dow values stay the same — we just visit them in a
// different order on screen.
const DOW_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function ChecklistTemplatesEditor({ canEdit }) {
  const [rows, setRows] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [editing, setEditing] = useState(null)   // { mode: 'edit'|'create', role, dow, template? }

  async function load() {
    try {
      const r = await fetch('/api/checklists/templates', { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setLoadError(j.error || `Failed (${r.status})`)
        return
      }
      setLoadError(null)
      setRows(j.data || [])
    } catch (e) {
      setLoadError(e.message || 'Network error')
    }
  }

  useEffect(() => { load() }, [])

  // index[role][dow] → template row | undefined.
  const index = useMemo(() => {
    const idx = {}
    for (const role of ROLES) idx[role] = {}
    for (const row of rows || []) {
      if (!row.enabled) continue
      idx[row.role][row.day_of_week] = row
    }
    return idx
  }, [rows])

  if (loadError) {
    return (
      <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded p-3 inline-flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" /> {loadError}
      </div>
    )
  }
  if (rows === null) {
    return (
      <div className="text-sm text-un1t-light inline-flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </div>
    )
  }

  return (
    <>
      {/* Grid */}
      <div className="overflow-x-auto">
        <table className="w-full border-separate" style={{ borderSpacing: '6px' }}>
          <thead>
            <tr>
              <th className="text-left text-[11px] uppercase tracking-wider text-un1t-light font-semibold px-2 py-1">Role</th>
              {DOW_DISPLAY_ORDER.map((dow) => (
                <th key={dow} className="text-left text-[11px] uppercase tracking-wider text-un1t-light font-semibold px-2 py-1">
                  {DAY_LABELS[dow]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROLES.map((role) => (
              <tr key={role}>
                <td className="text-sm font-semibold text-un1t-white px-2 py-2 whitespace-nowrap">{ROLE_LABELS[role]}</td>
                {DOW_DISPLAY_ORDER.map((dow) => {
                  const tpl = index[role][dow]
                  if (tpl) {
                    return (
                      <td key={dow}>
                        <button
                          type="button"
                          onClick={() => canEdit && setEditing({ mode: 'edit', role, dow, template: tpl })}
                          disabled={!canEdit}
                          className="w-full bg-blue-600/15 hover:bg-blue-600/25 border border-blue-500/40 rounded-md p-2 text-left disabled:cursor-default disabled:opacity-70"
                        >
                          <div className="text-[11px] uppercase tracking-wider text-blue-200 font-semibold truncate">
                            {tpl.name}
                          </div>
                          <div className="text-[11px] text-un1t-light mt-0.5 inline-flex items-center gap-1">
                            <CheckSquare size={11} /> {tpl.items?.length || 0} item{(tpl.items?.length || 0) === 1 ? '' : 's'}
                          </div>
                        </button>
                      </td>
                    )
                  }
                  return (
                    <td key={dow}>
                      {canEdit ? (
                        <button
                          type="button"
                          onClick={() => setEditing({ mode: 'create', role, dow })}
                          className="w-full bg-un1t-black/40 hover:bg-un1t-gray/30 border border-dashed border-un1t-gray/60 rounded-md p-2 text-un1t-mid inline-flex items-center justify-center gap-1.5 min-h-[58px]"
                        >
                          <Plus size={14} /> <span className="text-xs">Add</span>
                        </button>
                      ) : (
                        <div className="w-full bg-un1t-black/40 border border-dashed border-un1t-gray/60 rounded-md p-2 text-un1t-mid text-[11px] inline-flex items-center justify-center min-h-[58px]">
                          —
                        </div>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Editor drawer */}
      {editing && (
        <TemplateDrawer
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load() }}
        />
      )}

      {!canEdit && (
        <div className="mt-4 text-[12px] text-un1t-mid italic">
          Read-only — ask a master or owner to add new templates or edit items.
        </div>
      )}
    </>
  )
}

// ──────────────────────────────────────────────────────────────
// Drawer — create or edit a single template
// ──────────────────────────────────────────────────────────────

function TemplateDrawer({ editing, onClose, onSaved }) {
  const isEdit = editing.mode === 'edit'
  const [name, setName] = useState(editing.template?.name || '')
  const [items, setItems] = useState(
    (editing.template?.items || []).map((i) => ({ id: i.id, label: i.label }))
  )
  const [saving, setSaving] = useState(false)
  const [disabling, setDisabling] = useState(false)
  const [error, setError] = useState(null)

  function setItem(idx, label) {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, label } : it)))
  }
  function addItem() {
    setItems((prev) => [...prev, { label: '' }])
  }
  function removeItem(idx) {
    setItems((prev) => prev.filter((_, i) => i !== idx))
  }
  function moveItem(idx, delta) {
    setItems((prev) => {
      const target = idx + delta
      if (target < 0 || target >= prev.length) return prev
      const next = prev.slice()
      const tmp = next[idx]
      next[idx] = next[target]
      next[target] = tmp
      return next
    })
  }

  async function save() {
    setError(null)
    setSaving(true)
    try {
      const cleanedItems = items
        .map((i) => ({ ...i, label: (i.label || '').trim() }))
        .filter((i) => i.label.length > 0)

      const body = isEdit
        ? { name: name.trim(), items: cleanedItems }
        : {
            role:        editing.role,
            day_of_week: editing.dow,
            name:        name.trim(),
            items:       cleanedItems,
          }

      const url = isEdit
        ? `/api/checklists/templates/${editing.template.id}`
        : '/api/checklists/templates'
      const method = isEdit ? 'PATCH' : 'POST'
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.error || `Save failed (${r.status})`)
        return
      }
      await onSaved()
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setSaving(false)
    }
  }

  async function disableTemplate() {
    if (!editing.template?.id) return
    if (!window.confirm('Remove this template? Coaches won\'t see it from their next shift onward.')) return
    setDisabling(true)
    try {
      const r = await fetch(`/api/checklists/templates/${editing.template.id}`, { method: 'DELETE' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.error || `Delete failed (${r.status})`)
        return
      }
      await onSaved()
    } finally {
      setDisabling(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-un1t-dark border border-un1t-gray rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-un1t-gray">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider text-un1t-light">
                {ROLE_LABELS[editing.role]} · {DAY_LABELS[editing.dow]}
              </div>
              <h3 className="text-lg font-bold text-un1t-white mt-0.5 truncate">
                {isEdit ? 'Edit checklist' : 'New checklist'}
              </h3>
            </div>
            <button onClick={onClose} className="text-un1t-light hover:text-un1t-white p-1">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs text-un1t-light mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`e.g. ${DAY_LABELS[editing.dow]} ${ROLE_LABELS[editing.role].toLowerCase()} closer`}
              maxLength={100}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
            />
          </div>

          <div>
            <label className="block text-xs text-un1t-light mb-1.5">Items</label>
            {items.length === 0 ? (
              <div className="text-[12px] text-un1t-mid italic mb-2">No items yet — add one to get started.</div>
            ) : (
              <div className="space-y-1.5">
                {items.map((it, idx) => (
                  <div key={it.id || idx} className="flex items-center gap-2">
                    <div className="flex flex-col">
                      <button type="button" onClick={() => moveItem(idx, -1)} disabled={idx === 0} className="text-un1t-light hover:text-un1t-white disabled:opacity-30">
                        <GripVertical size={12} />
                      </button>
                    </div>
                    <Square size={14} className="text-un1t-mid shrink-0" />
                    <input
                      type="text"
                      value={it.label}
                      onChange={(e) => setItem(idx, e.target.value)}
                      placeholder={`Item ${idx + 1}`}
                      maxLength={200}
                      className="flex-1 bg-un1t-black border border-un1t-gray rounded-md px-3 py-1.5 text-sm text-un1t-white"
                    />
                    <button type="button" onClick={() => removeItem(idx)} className="text-red-400 hover:text-red-300">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={addItem}
              className="mt-3 text-xs text-blue-300 hover:text-blue-200 inline-flex items-center gap-1.5"
            >
              <Plus size={12} /> Add item
            </button>
          </div>

          {error && (
            <div className="text-[12px] text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-2">
              <AlertCircle size={12} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="p-5 border-t border-un1t-gray flex items-center justify-between gap-2">
          {isEdit ? (
            <button
              type="button"
              onClick={disableTemplate}
              disabled={disabling || saving}
              className="text-red-300 hover:text-red-200 text-sm inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              {disabling ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              Remove
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="text-un1t-light hover:text-un1t-white text-sm px-3 py-1.5">
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || name.trim().length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : (isEdit ? <Edit3 size={12} /> : <Save size={12} />)}
              {isEdit ? 'Save' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
