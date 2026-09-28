'use client'

// CHANNELREAD.1 — shows what GET /api/xero/callback redirected back with
// (`?xero_error=<code>` / `?xero_connected=1[&xero_orgs=N]`), then removes
// those params from the URL so a reload does not show it again.
//
// Mounted on every page the callback can land on: the Xero tab
// (/settings/locations/[id]?tab=xero, the default), the Integrations hub
// (the hub's Connect passes return_to=/settings/integrations-hub) and
// /settings (the fallback when the state was unusable).
//
// The copy comes from src/lib/xero/callback-notice.js by CODE; nothing from
// the URL is rendered. The notice is captured on first render, so cleaning
// the URL does not make it vanish; Dismiss does.

import { useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { X } from 'lucide-react'
import {
  xeroCallbackNotice,
  hasXeroCallbackParams,
  withoutXeroCallbackParams,
} from '@/lib/xero/callback-notice'

const TONE = {
  success: 'bg-emerald-500/10 text-emerald-700',
  error: 'bg-red-500/10 text-red-700',
}

export default function XeroCallbackNotice({ className = '' }) {
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const [notice, setNotice] = useState(() => xeroCallbackNotice(searchParams))

  const query = searchParams ? searchParams.toString() : ''
  useEffect(() => {
    const params = new URLSearchParams(query)
    if (!hasXeroCallbackParams(params)) return
    const rest = withoutXeroCallbackParams(params)
    router.replace(rest ? `${pathname}?${rest}` : pathname, { scroll: false })
  }, [query, pathname, router])

  if (!notice) return null
  return (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start justify-between gap-3 rounded px-3 py-2 text-sm ${TONE[notice.tone]} ${className}`}
    >
      <p>{notice.text}</p>
      <button
        type="button"
        onClick={() => setNotice(null)}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
