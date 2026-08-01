'use client'

// EQUIP-MAINT.3 — the compliance log: every submitted inspection at
// this studio, newest first. The view an owner puts in front of an
// insurer or an H&S auditor. Read-only — no CSV export, explicitly
// out of scope for this PR (the operator asked for on-screen only).

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, EmptyState, Table } from '@/components/ui'
import { FileCheck } from 'lucide-react'

const PAGE_SIZE = 50

/** How many items in `results` failed. results is { [itemId]: { state, ... } }. */
function faultCount(results) {
  return Object.values(results || {}).filter((r) => r?.state === 'fail').length
}

// Exported (not just inlined) so columns.test.js can assert every
// column resolves a defined cell value via the real cellValue() — a
// column with neither `accessor` nor `render` renders blank and
// nothing else catches that (the exact defect that shipped a blank
// name column in PR 1).
export function buildLogColumns() {
  return [
    { key: 'equipment', header: 'Equipment', render: (r) => r.equipment?.name || '—' },
    { key: 'type', header: 'Type', render: (r) => r.equipment_types?.name || '—' },
    { key: 'due', header: 'Due', accessor: 'due_on' },
    {
      key: 'submitted',
      header: 'Submitted',
      render: (r) => (r.submitted_at ? r.submitted_at.slice(0, 10) : '—'),
    },
    { key: 'inspector', header: 'Inspector', render: (r) => r.profiles?.full_name || '—' },
    {
      key: 'result',
      header: 'Result',
      render: (r) => {
        const faults = faultCount(r.results)
        return faults === 0 ? (
          <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700">Passed</span>
        ) : (
          <span className="rounded bg-red-500/10 px-2 py-0.5 text-xs text-red-700">
            {faults} fault{faults === 1 ? '' : 's'}
          </span>
        )
      },
    },
  ]
}

export default function LogTab() {
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [equipmentFilter, setEquipmentFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const load = useCallback(async (nextOffset, nextEquipmentFilter) => {
    setLoading(true)
    setLoadError(null)
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(nextOffset) })
      if (nextEquipmentFilter) params.set('equipmentId', nextEquipmentFilter)
      const res = await fetch(`/api/equipment/inspections?${params}`).then((r) => r.json())
      if (res.success) {
        setRows(res.data.rows)
        setTotal(res.data.total)
      } else {
        setLoadError(res.error || 'Failed to load the inspection log.')
      }
    } catch (err) {
      // Without this catch, a network failure never reaches
      // setLoading(false) and the table shows "Loading…" forever.
      setLoadError(err.message || 'Failed to load the inspection log.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(offset, equipmentFilter) }, [load, offset, equipmentFilter])

  const columns = buildLogColumns()
  const hasPrevious = offset > 0
  const hasNext = offset + rows.length < total

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between p-4">
          <div>
            <h2 className="font-medium text-un1t-text">Inspection log</h2>
            <p className="text-xs text-un1t-subtle">Every submitted inspection, newest first.</p>
          </div>
          {equipmentFilter && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => { setEquipmentFilter(''); setOffset(0) }}
            >
              Clear filter
            </Button>
          )}
        </div>
        {loadError && <p className="px-4 pb-4 text-sm text-red-700">{loadError}</p>}
        {!loading && rows.length === 0 ? (
          <EmptyState
            icon={<FileCheck className="h-6 w-6" />}
            title="No inspections logged yet"
            description="Submitted inspections will show up here as a running compliance record."
          />
        ) : (
          <Table columns={columns} rows={rows} loading={loading} empty="No inspections logged yet." />
        )}
        <div className="flex items-center justify-between gap-2 border-t border-un1t-border p-4">
          <p className="text-xs text-un1t-subtle">
            {total > 0 ? `${offset + 1}–${offset + rows.length} of ${total}` : ''}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!hasPrevious || loading}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!hasNext || loading}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
