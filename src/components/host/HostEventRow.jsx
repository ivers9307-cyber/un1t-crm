// HostEventRow — HOSTPORTAL.1. One event in a /host/events list: name + status
// chip + a detail line, the whole thing a link to where the event lands. The
// optional `action` node (the Submit button) sits outside the link so it is not
// a button nested in an anchor. Server-safe: no hooks, no handlers.

import Link from 'next/link'
import { HOST_EVENT_STATUS_LABEL } from '@/lib/host-events'
import { HOST_STATUS_CHIP, eventLandingHref } from '@/lib/host-portal'

export default function HostEventRow({ event, detail, action = null }) {
  const chip = HOST_STATUS_CHIP[event.status] || 'bg-white/10 text-white/70'
  return (
    <li className="px-4 py-3 flex items-center justify-between gap-4 hover:bg-white/[0.02]">
      <Link href={eventLandingHref(event)} className="min-w-0 flex-1">
        <p className="flex items-center gap-2 font-medium">
          <span className="truncate">{event.name}</span>
          {event.status && (
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${chip}`}>
              {HOST_EVENT_STATUS_LABEL[event.status] || event.status}
            </span>
          )}
        </p>
        <p className="text-xs text-white/45 break-words">{detail}</p>
      </Link>
      {action ? <div className="shrink-0 text-xs">{action}</div> : null}
    </li>
  )
}
