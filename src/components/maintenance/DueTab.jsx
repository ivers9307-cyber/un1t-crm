'use client'

// EQUIP-MAINT.2 — the Due tab: what needs inspecting right now, plus
// what is currently off the floor. Visible to anyone holding
// equipment_inspect (the universal default) — this component must
// NOT be gated behind canAdmin; that gate belongs to the Equipment /
// Types setup tabs only (see MaintenanceView.jsx).

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ClipboardCheck, Settings, Wrench } from 'lucide-react'
import { Button, Card, EmptyState, Table } from '@/components/ui'
import InspectionRunner from './InspectionRunner'

// Exported (not just inlined) so columns.test.js can assert every
// column resolves a defined cell value via the real cellValue() — a
// column with neither `accessor` nor `render` renders blank and
// nothing else catches that (see styles.js cellValue). This is the
// exact defect that shipped a blank name column in PR 1.
export function buildDueColumns({ today, onInspect }) {
  return [
    { key: 'name', header: 'Equipment', accessor: 'name' },
    { key: 'type', header: 'Type', render: (r) => r.equipment_types?.name || '—' },
    { key: 'zone', header: 'Zone', render: (r) => r.zone || '—' },
    {
      key: 'due',
      header: 'Next due',
      // Every row here is already due (the API only returns
      // in-service assets with next_due_on <= today) — the chip
      // distinguishes strictly-overdue from due-today rather than
      // asking "is this due at all".
      render: (r) => {
        const overdue = r.next_due_on < today
        return (
          <span className={
            overdue
              ? 'rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700'
              : 'text-un1t-text'
          }>
            {r.next_due_on}{overdue ? ' · overdue' : ''}
          </span>
        )
      },
    },
    {
      key: 'inspect',
      header: '',
      align: 'right',
      render: (r) => (
        <Button
          type="button"
          size="sm"
          onClick={(e) => { e.stopPropagation(); onInspect(r) }}
        >
          Inspect
        </Button>
      ),
    },
  ]
}

export default function DueTab() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [running, setRunning] = useState(null) // the due row being inspected

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch('/api/equipment/due').then((r) => r.json())
      if (res.success) setData(res.data)
      else setLoadError(res.error || 'Failed to load the due list.')
    } catch (err) {
      // Without this catch, a network failure never reaches
      // setLoading(false) and the table shows "Loading…" forever.
      setLoadError(err.message || 'Failed to load the due list.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) {
    return (
      <Card>
        <p className="py-8 text-center text-sm text-un1t-subtle">Loading…</p>
      </Card>
    )
  }

  if (loadError) {
    return (
      <Card>
        <p className="py-8 text-center text-sm text-red-700">{loadError}</p>
      </Card>
    )
  }

  if (!data?.enabled) {
    return (
      <Card>
        <EmptyState
          icon={<Settings className="h-6 w-6" />}
          title="Inspections aren't set up for this studio yet"
          description="An admin needs to add equipment types and register assets on the Equipment and Types tabs, then switch inspections on there."
        />
      </Card>
    )
  }

  const columns = buildDueColumns({ today: data.today, onInspect: (r) => setRunning(r) })
  const outOfService = data.outOfService || []

  return (
    <div className="space-y-6">
      <Card>
        {data.due.length === 0 ? (
          <EmptyState
            icon={<ClipboardCheck className="h-6 w-6" />}
            title="Nothing due"
            description="Every in-service asset at this studio is inspected and up to date."
          />
        ) : (
          <Table
            columns={columns}
            rows={data.due}
            empty="Nothing due."
          />
        )}
      </Card>

      {outOfService.length > 0 && (
        <Card>
          <div className="p-4 pb-2">
            <h2 className="font-medium text-un1t-text">Out of service</h2>
            <p className="text-xs text-un1t-subtle">
              Taken off the floor by a failed inspection. Resolving the linked issue returns the asset to service.
            </p>
          </div>
          <div className="divide-y divide-un1t-border">
            {outOfService.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-un1t-text">{r.name}</p>
                  <p className="text-xs text-un1t-subtle">{r.equipment_types?.name || '—'}{r.zone ? ` · ${r.zone}` : ''}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="rounded bg-red-500/10 px-2 py-0.5 text-xs text-red-700">Out of service</span>
                  {r.out_of_service_issue_id && (
                    <Link href="/issues" className="inline-flex items-center gap-1 text-xs text-un1t-accent hover:underline">
                      <Wrench className="h-3 w-3" aria-hidden="true" /> View issue
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {running && (
        <InspectionRunner
          equipmentId={running.id}
          equipmentName={running.name}
          onClose={() => setRunning(null)}
          onSubmitted={() => { setRunning(null); load() }}
        />
      )}
    </div>
  )
}
