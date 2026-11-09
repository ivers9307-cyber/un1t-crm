'use client'
// HostPastEvents — HOSTPORTAL.1. The Past group on /host/events: the newest 20
// rows, with a "Show all" button for the rest. `rows` is plain data
// ({ id, name, status, statusLabel, href, detail }); the server page builds it.

import { useState } from 'react'
import Link from 'next/link'

// Same recipe as HOST_STATUS_CHIP in @/lib/host-portal, copied because that
// module reads the database and must not enter a client bundle.
const HOST_STATUS_CHIP = {
  draft: 'bg-white/10 text-white/70',
  pending_review: 'bg-amber-500/15 text-amber-300',
  published: 'bg-emerald-500/15 text-emerald-300',
  rejected: 'bg-red-500/15 text-red-300',
}

const FIRST = 20

export default function HostPastEvents({ rows }) {
  const [all, setAll] = useState(false)
  const list = Array.isArray(rows) ? rows : []
  const shown = all ? list : list.slice(0, FIRST)
  return (
    <>
      <ul className="divide-y divide-white/10 rounded-xl border border-white/10 overflow-hidden">
        {shown.map((r) => (
          <li key={r.id} className="px-4 py-3 hover:bg-white/[0.02]">
            <Link href={r.href} className="block min-w-0">
              <p className="flex items-center gap-2 font-medium">
                <span className="truncate">{r.name}</span>
                {r.status && (
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${HOST_STATUS_CHIP[r.status] || 'bg-white/10 text-white/70'}`}>
                    {r.statusLabel || r.status}
                  </span>
                )}
              </p>
              <p className="text-xs text-white/45 break-words">{r.detail}</p>
            </Link>
          </li>
        ))}
      </ul>
      {!all && list.length > FIRST && (
        <button type="button" onClick={() => setAll(true)} className="mt-2 text-xs text-white/50 hover:text-white">
          Show all {list.length}
        </button>
      )}
    </>
  )
}
