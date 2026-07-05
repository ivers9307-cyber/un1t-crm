// RCOV.P2 — the /accounting hub's tab shell. Visited panels stay
// mounted (hidden, not unmounted) so switching tabs doesn't refetch.
'use client'

import { useState } from 'react'
import CoverageBoard from '@/components/accounting/CoverageBoard'
import ExceptionsPanel from '@/components/accounting/ExceptionsPanel'
import RunsHealthPanel from '@/components/accounting/RunsHealthPanel'

const TABS = [
  { id: 'coverage', label: 'Coverage' },
  { id: 'exceptions', label: 'Exceptions' },
  { id: 'health', label: 'Runs & health' },
]

export default function AccountingTabs({ locationName }) {
  const [active, setActive] = useState('coverage')
  const [visited, setVisited] = useState({ coverage: true })

  const open = (id) => {
    setActive(id)
    setVisited((v) => ({ ...v, [id]: true }))
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => open(t.id)}
            className={`text-xs px-3 py-1.5 rounded ${active === t.id ? 'bg-un1t-text text-un1t-bg' : 'bg-gray-500/10 text-gray-700'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={active === 'coverage' ? '' : 'hidden'}>
        {visited.coverage ? <CoverageBoard locationName={locationName} /> : null}
      </div>
      <div className={active === 'exceptions' ? '' : 'hidden'}>
        {visited.exceptions ? <ExceptionsPanel /> : null}
      </div>
      <div className={active === 'health' ? '' : 'hidden'}>
        {visited.health ? <RunsHealthPanel /> : null}
      </div>
    </div>
  )
}
