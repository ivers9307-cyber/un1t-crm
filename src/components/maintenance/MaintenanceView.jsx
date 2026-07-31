'use client'

// EQUIP-MAINT.1/2 — /maintenance tab shell. Due now runs real
// inspections (EQUIP-MAINT.2); Equipment + Types shipped in PR 1.
//
// Equipment + Types are setup surfaces (register, checklists,
// intervals, inspection weekday) and are only rendered when `canAdmin`
// — a plain equipment_inspect grant (the universal default) sees the
// Due tab only, with the setup tab pills never entering the DOM.
// `canAdmin` is resolved server-side in page.js via hasPermission();
// this component never re-derives it from the client. DueTab itself
// must stay ungated by canAdmin — it is the surface every
// equipment_inspect holder needs.

import { useState } from 'react'
import DueTab from './DueTab'
import TypesTab from './TypesTab'
import EquipmentTab from './EquipmentTab'

export default function MaintenanceView({ canAdmin }) {
  const TABS = [
    { key: 'due', label: 'Due' },
    ...(canAdmin ? [
      { key: 'equipment', label: 'Equipment' },
      { key: 'types', label: 'Types' },
    ] : []),
  ]
  const [tab, setTab] = useState(canAdmin ? 'equipment' : 'due')

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-un1t-text">Maintenance</h1>
        <p className="text-sm text-un1t-muted">
          Equipment register, inspection checklists and schedules.
        </p>
      </div>

      <div className="flex gap-2 border-b border-un1t-border">
        {TABS.map((t) => (
          // type="button" is REQUIRED — a bare <button> defaults to
          // type="submit" and will submit any form it ends up inside.
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              'px-3 py-2 text-sm ' +
              (tab === t.key
                ? 'border-b-2 border-un1t-accent font-medium text-un1t-text'
                : 'text-un1t-muted hover:text-un1t-text')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'due' && <DueTab />}
      {canAdmin && tab === 'equipment' && <EquipmentTab />}
      {canAdmin && tab === 'types' && <TypesTab />}
    </div>
  )
}
