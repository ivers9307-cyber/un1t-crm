// The "who's booked into the class running now" panel. Shared by the full live
// board (LiveClassClient) and the roster-only view (LiveRosterClient,
// UN1TBOOK.13). `hasBridge` is false when the location has no BLE bridge, so no
// strap can ever be present and "p/n booked here" would only ever read 0/n.

import { Users } from 'lucide-react'

export default function ClassRosterPanel({ roster, occurrence, hasBridge = true }) {
  // Only shown while a class is live (occurrence resolved) and there's a roster
  // or walk-ins to show. HR-CLASS-ALLOC.2.
  if (!occurrence || roster.length === 0) return null
  const booked = roster.filter((r) => r.booked)
  const presentBooked = booked.filter((r) => r.hasHr).length
  const walkins = roster.filter((r) => !r.booked)

  return (
    <section className="mt-8 rounded-2xl border border-un1t-border bg-white p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Users size={16} className="text-un1t-subtle" />
        <h2 className="text-sm font-semibold">Class roster</h2>
        {occurrence.class_name && (
          <span className="rounded-full bg-un1t-border px-2 py-0.5 text-[11px] font-medium text-un1t-subtle">
            {occurrence.class_name}
          </span>
        )}
        <span className="ml-auto text-xs text-un1t-subtle">
          {hasBridge ? `${presentBooked}/${booked.length} booked here` : `${booked.length} booked`}
          {walkins.length > 0 && ` · ${walkins.length} walk-in${walkins.length > 1 ? 's' : ''}`}
        </span>
      </div>

      <ul className="mt-3 divide-y divide-un1t-border">
        {roster.map((r, i) => (
          <li key={r.sessionId || `roster-${i}`} className="flex items-center gap-3 py-2">
            <span className={`min-w-0 flex-1 truncate text-sm ${r.hasHr ? 'font-medium' : 'text-un1t-subtle'}`}>
              {r.anon ? <span className="font-mono">{r.label}</span> : r.label}
              {r.anon && <span className="ml-1.5 text-[10px] font-semibold uppercase text-indigo-700">walk-in</span>}
              {!r.booked && !r.anon && <span className="ml-1.5 text-[10px] text-amber-700">not booked</span>}
            </span>
            {r.hasHr ? (
              <span className="shrink-0 text-sm font-semibold tabular-nums">
                {r.currentBpm ?? '—'}<span className="ml-0.5 text-[10px] font-normal text-un1t-subtle">bpm</span>
              </span>
            ) : (
              <span className="shrink-0 text-[11px] text-un1t-subtle">no strap</span>
            )}
            {r.booked && (
              <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                booked
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
