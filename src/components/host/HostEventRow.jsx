// HostEventRow — HOSTPORTAL.1. One event in a /host/events list: name + status
// chip + a detail line, the whole thing a link to where the event lands. The
// optional `action` node (the Submit button) sits outside the link so it is not
// a button nested in an anchor. Server-safe: no hooks, no handlers.

import Link from 'next/link'
import { HOST_EVENT_STATUS_LABEL } from '@/lib/host-events'
import { HOST_STATUS_CHIP, eventLandingHref } from '@/lib/host-portal'
import { HOST_CHIP, HOST_CHIP_TONE, HOST_ROW, HOST_META } from './host-ui'

export default function HostEventRow({ event, detail, action = null }) {
  const chip = HOST_STATUS_CHIP[event.status] || `${HOST_CHIP} ${HOST_CHIP_TONE.neutral}`
  return (
    <li className={`${HOST_ROW} flex items-center justify-between gap-4`}>
      <Link href={eventLandingHref(event)} className="min-w-0 flex-1">
        <p className="flex items-center gap-2 font-medium">
          <span className="truncate">{event.name}</span>
          {event.status && (
            <span className={`shrink-0 ${chip}`}>
              {HOST_EVENT_STATUS_LABEL[event.status] || event.status}
            </span>
          )}
        </p>
        <p className={`${HOST_META} break-words`}>{detail}</p>
      </Link>
      {action ? <div className="shrink-0 text-xs">{action}</div> : null}
    </li>
  )
}
