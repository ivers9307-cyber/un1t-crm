'use client'

// EQUIP-MAINT.1 — the equipment register: list + create/edit/retire.
// Structure mirrors TypesTab.jsx: a Card with an "Add equipment"
// Button, a Table, and a Modal holding the create/edit form.

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Field, Modal, Table } from '@/components/ui'
import { isDue } from '@/lib/equipment'
import { dublinTodayStr } from '@/lib/dublin-time'
import { STATUS_CHIP, STATUS_LABEL } from './helpers'

// Exported (not just inlined in the component) so columns.test.js can
// assert every column resolves a defined cell value via the real
// cellValue() — a column with neither `accessor` nor `render` renders
// blank and nothing else catches that (see styles.js cellValue).
export function buildEquipmentColumns(today) {
  return [
    { key: 'name', header: 'Equipment', accessor: 'name' },
    { key: 'type', header: 'Type', render: (r) => r.equipment_types?.name || '—' },
    { key: 'zone', header: 'Zone', render: (r) => r.zone || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <span className={`rounded px-2 py-0.5 text-xs ${STATUS_CHIP[r.status]}`}>
          {STATUS_LABEL[r.status]}
        </span>
      ),
    },
    { key: 'last', header: 'Last inspected', render: (r) => r.last_inspected_on || 'Never' },
    {
      key: 'due',
      header: 'Next due',
      // Use isDue(), NOT a bare `r.next_due_on <= today`. isDue also requires
      // status === 'in_service', so an out-of-service asset does not show an
      // amber "due" chip while being correctly absent from the due list.
      // Three definitions of "due" would otherwise ship in one PR.
      render: (r) => (
        <span className={
          isDue(r, today)
            ? 'rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700'
            : 'text-un1t-muted'
        }>
          {r.next_due_on}
        </span>
      ),
    },
  ]
}

const EMPTY_EQUIPMENT = {
  id: null,
  typeId: '',
  name: '',
  assetTag: '',
  serialNumber: '',
  manufacturer: '',
  zone: '',
  purchaseDate: '',
  notes: '',
  firstDueOn: '',
  status: 'in_service',
}

export default function EquipmentTab() {
  const [equipment, setEquipment] = useState([])
  const [types, setTypes] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [retiring, setRetiring] = useState(false)
  // Dublin's calendar day, not the browser's — a staff phone/laptop set
  // to another timezone must not shift what counts as "due today".
  // dublinTodayStr() (dublin-time.js) is client-safe (Intl only, no
  // server-only import) — seven other client components already use it.
  const [today] = useState(() => dublinTodayStr())

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [eRes, tRes] = await Promise.all([
        fetch('/api/equipment').then((r) => r.json()),
        fetch('/api/equipment/types').then((r) => r.json()),
      ])
      if (eRes.success) setEquipment(eRes.data)
      else setLoadError(eRes.error || 'Failed to load equipment.')
      if (tRes.success) setTypes(tRes.data)
    } catch (err) {
      // Without this catch, a network failure never reaches
      // setLoading(false) and the table shows "Loading…" forever.
      setLoadError(err.message || 'Failed to load equipment.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function openCreate() {
    setError(null)
    setEditing({ ...EMPTY_EQUIPMENT, typeId: types[0]?.id || '' })
  }

  function openEdit(row) {
    setError(null)
    setEditing({
      id: row.id,
      typeId: row.type_id,
      name: row.name,
      assetTag: row.asset_tag || '',
      serialNumber: row.serial_number || '',
      manufacturer: row.manufacturer || '',
      zone: row.zone || '',
      purchaseDate: row.purchase_date || '',
      notes: row.notes || '',
      firstDueOn: '',
      status: row.status,
    })
  }

  async function saveEquipment(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const body = {
        typeId: editing.typeId,
        name: editing.name,
        assetTag: editing.assetTag.trim() || null,
        serialNumber: editing.serialNumber.trim() || null,
        manufacturer: editing.manufacturer.trim() || null,
        zone: editing.zone.trim() || null,
        purchaseDate: editing.purchaseDate || null,
        notes: editing.notes.trim() || null,
      }
      if (editing.id) {
        body.status = editing.status
      } else {
        body.firstDueOn = editing.firstDueOn || null
      }

      const res = await fetch(
        editing.id ? `/api/equipment/${editing.id}` : '/api/equipment',
        {
          method: editing.id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      ).then((r) => r.json())

      if (!res.success) { setError(res.error); return }
      setEditing(null)
      load()
    } catch (err) {
      setError(err.message || 'Failed to save equipment.')
    } finally {
      setSaving(false)
    }
  }

  async function retireEquipment() {
    if (!editing?.id) return
    if (!window.confirm(`Retire ${editing.name}? This cannot be undone from here.`)) return
    setRetiring(true)
    setError(null)
    try {
      const res = await fetch(`/api/equipment/${editing.id}`, { method: 'DELETE' }).then((r) => r.json())
      if (!res.success) { setError(res.error); return }
      setEditing(null)
      load()
    } catch (err) {
      setError(err.message || 'Failed to retire equipment.')
    } finally {
      setRetiring(false)
    }
  }

  const columns = buildEquipmentColumns(today)

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-center justify-between p-4">
          <h2 className="font-medium text-un1t-text">Equipment register</h2>
          <Button type="button" onClick={openCreate} disabled={types.length === 0}>Add equipment</Button>
        </div>
        {types.length === 0 && !loading && (
          <p className="px-4 pb-4 text-sm text-un1t-subtle">
            Add an equipment type on the Types tab before registering assets.
          </p>
        )}
        {loadError && <p className="px-4 pb-4 text-sm text-red-700">{loadError}</p>}
        <Table
          columns={columns}
          rows={equipment}
          loading={loading}
          empty="No equipment registered yet. Add your first asset to get started."
          onRowClick={openEdit}
        />
      </Card>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit equipment' : 'New equipment'}
      >
        {editing && (
          <form onSubmit={saveEquipment} className="space-y-4">
            <Field id="equipment-type" label="Type" required>
              <select
                id="equipment-type"
                className="w-full rounded border border-un1t-border px-2 py-1 text-sm"
                value={editing.typeId}
                onChange={(e) => setEditing({ ...editing, typeId: e.target.value })}
                required
              >
                <option value="" disabled>Select a type…</option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </Field>

            <Field id="equipment-name" label="Name" required>
              <input
                id="equipment-name"
                className="w-full rounded border border-un1t-border px-2 py-1 text-sm"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                maxLength={100}
                required
              />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field id="equipment-asset-tag" label="Asset tag">
                <input
                  id="equipment-asset-tag"
                  className="w-full rounded border border-un1t-border px-2 py-1 text-sm"
                  value={editing.assetTag}
                  onChange={(e) => setEditing({ ...editing, assetTag: e.target.value })}
                  maxLength={50}
                />
              </Field>
              <Field id="equipment-serial" label="Serial number">
                <input
                  id="equipment-serial"
                  className="w-full rounded border border-un1t-border px-2 py-1 text-sm"
                  value={editing.serialNumber}
                  onChange={(e) => setEditing({ ...editing, serialNumber: e.target.value })}
                  maxLength={100}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field id="equipment-manufacturer" label="Manufacturer">
                <input
                  id="equipment-manufacturer"
                  className="w-full rounded border border-un1t-border px-2 py-1 text-sm"
                  value={editing.manufacturer}
                  onChange={(e) => setEditing({ ...editing, manufacturer: e.target.value })}
                  maxLength={100}
                />
              </Field>
              <Field id="equipment-zone" label="Zone">
                <input
                  id="equipment-zone"
                  className="w-full rounded border border-un1t-border px-2 py-1 text-sm"
                  value={editing.zone}
                  onChange={(e) => setEditing({ ...editing, zone: e.target.value })}
                  maxLength={100}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field id="equipment-purchase-date" label="Purchase date">
                <input
                  id="equipment-purchase-date"
                  type="date"
                  className="w-full rounded border border-un1t-border px-2 py-1 text-sm"
                  value={editing.purchaseDate}
                  onChange={(e) => setEditing({ ...editing, purchaseDate: e.target.value })}
                />
              </Field>
              {!editing.id && (
                <Field id="equipment-first-due" label="First due" hint="Leave blank to use the studio's next inspection day.">
                  <input
                    id="equipment-first-due"
                    type="date"
                    className="w-full rounded border border-un1t-border px-2 py-1 text-sm"
                    value={editing.firstDueOn}
                    onChange={(e) => setEditing({ ...editing, firstDueOn: e.target.value })}
                  />
                </Field>
              )}
              {editing.id && (
                <Field id="equipment-status" label="Status">
                  <select
                    id="equipment-status"
                    className="w-full rounded border border-un1t-border px-2 py-1 text-sm"
                    value={editing.status}
                    onChange={(e) => setEditing({ ...editing, status: e.target.value })}
                  >
                    <option value="in_service">{STATUS_LABEL.in_service}</option>
                    <option value="out_of_service">{STATUS_LABEL.out_of_service}</option>
                  </select>
                </Field>
              )}
            </div>

            <Field id="equipment-notes" label="Notes">
              <textarea
                id="equipment-notes"
                className="w-full rounded border border-un1t-border px-2 py-1 text-sm"
                rows={3}
                value={editing.notes}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                maxLength={2000}
              />
            </Field>

            {error && <p className="text-sm text-red-700">{error}</p>}

            <div className="flex items-center justify-between gap-2">
              {editing.id ? (
                <Button type="button" variant="danger" onClick={retireEquipment} loading={retiring}>
                  Retire
                </Button>
              ) : <span />}
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                <Button type="submit" loading={saving}>Save</Button>
              </div>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
