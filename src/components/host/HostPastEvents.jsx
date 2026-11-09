'use client'
// HostPastEvents — HOSTPORTAL.1. The Past group on /host/events: the newest 20
// rows, with a "Show all" button for the rest. `rows` is plain data
// ({ id, name, status, statusLabel, href, detail, chip }); the server page builds it.

import { useState } from 'react'
import Link from 'next/link'
import { HOST_CHIP, HOST_CHIP_TONE, HOST_LIST, HOST_ROW, HOST_META, HOST_BTN_GHOST } from './host-ui'

// The server page passes each row's chip class string (r.chip, from
// HOST_STATUS_CHIP in @/lib/host-portal, which reads the database and must not
// enter a client bundle); an unknown status falls back to the neutral chip.
const NEUTRAL_CHIP = `${HOST_CHIP} ${HOST_CHIP_TONE.neutral}`

const FIRST = 20

export default function HostPastEvents({ rows }) {
  const [all, setAll] = useState(false)
  const list = Array.isArray(rows) ? rows : []
  const shown = all ? list : list.slice(0, FIRST)
  return (
    <>
      <ul className={`${HOST_LIST} overflow-hidden`}>
        {shown.map((r) => (
          <li key={r.id} className={HOST_ROW}>
            <Link href={r.href} className="block min-w-0">
              <p className="flex items-center gap-2 font-medium">
                <span className="truncate">{r.name}</span>
                {r.status && (
                  <span className={`shrink-0 ${r.chip || NEUTRAL_CHIP}`}>
                    {r.statusLabel || r.status}
                  </span>
                )}
              </p>
              <p className={`${HOST_META} break-words`}>{r.detail}</p>
            </Link>
          </li>
        ))}
      </ul>
      {!all && list.length > FIRST && (
        <button type="button" onClick={() => setAll(true)} className={`mt-2 ${HOST_BTN_GHOST}`}>
          Show all {list.length}
        </button>
      )}
    </>
  )
}
