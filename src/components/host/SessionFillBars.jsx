// HOSTPORTAL.2 — how full each session of an event is, one row per session.
// Pure render of loadSessionFill's `sessions` (dark host theme); no hooks, so
// it renders on the server. No capacity: a count and no bar.

export default function SessionFillBars({ sessions }) {
  return (
    <ul className="space-y-3">
      {(sessions || []).map((s) => {
        const hasCap = s.capacity != null && s.capacity > 0
        const pct = hasCap ? Math.min(100, (s.booked / s.capacity) * 100) : 0
        return (
          <li key={s.id}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-host-label">{s.label ? `${s.time} · ${s.label}` : s.time}</span>
              <span className="shrink-0 tabular-nums text-host-hint">
                {s.capacity == null ? `${s.booked} booked` : `${s.booked} / ${s.capacity}${s.full ? ' · full' : ''}`}
              </span>
            </div>
            {s.capacity != null && (
              <div className="mt-1.5 h-1.5 rounded-full border border-host-border bg-host-well overflow-hidden">
                <div
                  data-fill
                  className={`h-full rounded-full ${s.full ? 'bg-host-warn' : 'bg-host-accent'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
