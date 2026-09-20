// RUNWAY.1 — the Today page's roster-runway chip. One per studio whose next
// week is not ready (shared/roster-runway.js decides). Amber inside 10 days,
// red inside 5. Links straight to that week on the manager calendar, which
// reads ?view= and ?week= on mount (ScheduleCalendar.jsx).
//
// Server-renderable: no state, no effects. The caller decides WHO sees it
// (managers at that studio only); this component only draws what it is given.

import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { rosterRunwayHeadline, rosterRunwayDetail } from '@shared/roster-runway'

const TONES = {
  red: {
    box: 'border-red-500/40 bg-red-500/10 hover:bg-red-500/15',
    icon: 'text-red-600', title: 'text-red-700', detail: 'text-red-700/80',
  },
  amber: {
    box: 'border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/15',
    icon: 'text-amber-600', title: 'text-amber-700', detail: 'text-amber-700/90',
  },
}

export default function RosterRunwayChip({ runway, locationName = '' }) {
  if (!runway) return null
  const tone = TONES[runway.severity] || TONES.amber
  return (
    <Link
      href={`/schedule?view=week&week=${runway.weekStart}`}
      data-testid="roster-runway-chip"
      data-severity={runway.severity}
      className={`block mt-3 p-3 rounded-lg border transition-colors ${tone.box}`}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle size={16} className={`${tone.icon} mt-0.5 flex-shrink-0`} />
        <div className="flex-1 min-w-0">
          <div className={`text-sm font-medium ${tone.title}`}>
            {rosterRunwayHeadline(runway, { locationName })}
          </div>
          <div className={`text-xs mt-0.5 ${tone.detail}`}>
            {rosterRunwayDetail(runway)} Click to open that week.
          </div>
        </div>
      </div>
    </Link>
  )
}
