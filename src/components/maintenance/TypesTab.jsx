'use client'

// EQUIP-MAINT.1 — equipment types: the checklist + interval assets inherit.
// Also hosts the location's inspection weekday + feature switch.

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Field, Modal, Table } from '@/components/ui'
import { formatInterval, INTERVAL_OPTIONS, WEEKDAYS } from './helpers'

const EMPTY_TYPE = { id: null, name: '', intervalWeeks: 4, items: [] }

export default function TypesTab() {
  const [types, setTypes] = useState([])
  const [settings, setSettings] = useState({ inspection_day_of_week: 2, enabled: false })
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [tRes, sRes] = await Promise.all([
      fetch('/api/equipment/types?includeDisabled=1').then((r) => r.json()),
      fetch('/api/equipment/settings').then((r) => r.json()),
    ])
    if (tRes.success) setTypes(tRes.data)
    if (sRes.success && sRes.data) setSettings(sRes.data)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function saveSettings(patch) {
    const next = { ...settings, ...patch }
    setSettings(next)
    await fetch('/api/equipment/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inspectionDayOfWeek: next.inspection_day_of_week,
        enabled: next.enabled,
      }),
    })
  }

  async function saveType(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const body = {
      name: editing.name,
      intervalWeeks: editing.intervalWeeks,
      items: editing.items,
    }
    const res = await fetch(
      editing.id ? `/api/equipment/types/${editing.id}` : '/api/equipment/types',
      {
        method: editing.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    ).then((r) => r.json())
    setSaving(false)
    if (!res.success) { setError(res.error); return }
    setEditing(null)
    load()
  }

  // A fresh uuid per item, generated ONCE on add and never regenerated
  // on edit — stable ids are what preserve inspection history across a
  // label rename.
  function addItem() {
    setEditing((t) => ({ ...t, items: [...t.items, { id: crypto.randomUUID(), label: '' }] }))
  }
  function setItemLabel(idx, label) {
    setEditing((t) => ({ ...t, items: t.items.map((it, i) => (i === idx ? { ...it, label } : it)) }))
  }
  function removeItem(idx) {
    setEditing((t) => ({ ...t, items: t.items.filter((_, i) => i !== idx) }))
  }

  const columns = [
    { key: 'name', header: 'Type' },
    { key: 'interval', header: 'Interval', render: (r) => formatInterval(r.interval_weeks) },
    { key: 'items', header: 'Checks', render: (r) => (r.items || []).length },
    {
      key: 'enabled',
      header: 'Status',
      render: (r) => (
        <span className={`rounded px-2 py-0.5 text-xs ${r.enabled ? 'bg-emerald-500/10 text-emerald-700' : 'bg-slate-500/10 text-slate-700'}`}>
          {r.enabled ? 'Active' : 'Disabled'}
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-end gap-4 p-4">
          <Field id="inspection-day" label="Inspection day" hint="The weekday inspections are due and reminders are sent.">
            <select
              id="inspection-day"
              className="rounded border border-un1t-border px-2 py-1 text-sm"
              value={settings.inspection_day_of_week}
              onChange={(e) => saveSettings({ inspection_day_of_week: Number(e.target.value) })}
            >
              {WEEKDAYS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </Field>
          <Field id="enabled" label="Feature enabled" hint="Off means no due lists and no reminders at this studio.">
            <input
              id="enabled"
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => saveSettings({ enabled: e.target.checked })}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between p-4">
          <h2 className="font-medium text-un1t-text">Equipment types</h2>
          <Button type="button" onClick={() => setEditing({ ...EMPTY_TYPE })}>Add type</Button>
        </div>
        <Table
          columns={columns}
          rows={types}
          loading={loading}
          empty="No equipment types yet. Add one to get started."
          onRowClick={(r) => setEditing({
            id: r.id, name: r.name, intervalWeeks: r.interval_weeks, items: r.items || [],
          })}
        />
      </Card>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit equipment type' : 'New equipment type'}
      >
        {editing && (
          <form onSubmit={saveType} className="space-y-4">
            <Field id="type-name" label="Name" required>
              <input
                id="type-name"
                className="w-full rounded border border-un1t-border px-2 py-1 text-sm"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                maxLength={100}
                required
              />
            </Field>

            <Field id="type-interval" label="Inspect every">
              <select
                id="type-interval"
                className="rounded border border-un1t-border px-2 py-1 text-sm"
                value={editing.intervalWeeks}
                onChange={(e) => setEditing({ ...editing, intervalWeeks: Number(e.target.value) })}
              >
                {INTERVAL_OPTIONS.map((w) => (
                  <option key={w} value={w}>{formatInterval(w)}</option>
                ))}
              </select>
            </Field>

            <div className="space-y-2">
              <p className="text-sm font-medium text-un1t-text">Checklist</p>
              {editing.items.map((item, idx) => (
                <div key={item.id} className="flex gap-2">
                  <input
                    className="flex-1 rounded border border-un1t-border px-2 py-1 text-sm"
                    value={item.label}
                    onChange={(e) => setItemLabel(idx, e.target.value)}
                    placeholder="e.g. Emergency stop works"
                    maxLength={200}
                  />
                  <Button type="button" variant="ghost" onClick={() => removeItem(idx)}>Remove</Button>
                </div>
              ))}
              <Button type="button" variant="secondary" onClick={addItem}>Add check</Button>
            </div>

            {error && <p className="text-sm text-red-700">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button type="submit" loading={saving}>Save</Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
