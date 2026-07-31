'use client'

// NOTIF.4 — admin test-push button.
//
// Fires a categoryless push at a specific user via /api/admin/push/test.
// Surfaces the response inline (n sent / n invalidated). Useful for
// verifying end-to-end delivery without waiting for a real reminder.
//
// "0 sent · n blocked" here means the recipient's master
// push_notifications switch is off — not a device problem. It used to
// also mean "the diagnostic suppressed itself"; see the route's header
// for why there is no category (PUSH-TEST.1).

import { useState } from 'react'
import { Send, Check, AlertTriangle, Loader2 } from 'lucide-react'

export default function TestPushButton({ recipientId, recipientName }) {
  const [state, setState] = useState('idle')  // 'idle' | 'sending' | 'done' | 'error'
  const [result, setResult] = useState(null)

  async function send() {
    setState('sending')
    setResult(null)
    try {
      const res = await fetch('/api/admin/push/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_id: recipientId }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) {
        setState('error')
        setResult(j.error || `HTTP ${res.status}`)
      } else {
        setState('done')
        setResult(j.data)
        setTimeout(() => { setState('idle'); setResult(null) }, 4000)
      }
    } catch (e) {
      setState('error')
      setResult(e.message || 'Network error')
    }
  }

  if (state === 'done' && result) {
    const { sent, skipped, invalidated } = result
    return (
      <span className="inline-flex items-center gap-1 text-[11px]">
        {sent > 0
          ? <><Check size={12} className="text-emerald-400" /> <span className="text-emerald-300">sent {sent}</span></>
          : <><AlertTriangle size={12} className="text-amber-400" /> <span className="text-amber-200">0 sent</span></>}
        {invalidated > 0 && <span className="text-red-300">· {invalidated} stale</span>}
        {skipped > 0 && <span className="text-un1t-muted">· {skipped} blocked</span>}
      </span>
    )
  }

  if (state === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-red-300" title={result}>
        <AlertTriangle size={12} /> failed
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={send}
      disabled={state === 'sending'}
      title={`Send a test push to ${recipientName}`}
      className="inline-flex items-center gap-1 text-[11px] text-un1t-subtle hover:text-un1t-text border border-un1t-border rounded px-2 py-1 disabled:opacity-50"
    >
      {state === 'sending'
        ? <><Loader2 size={11} className="animate-spin" /> sending</>
        : <><Send size={11} /> Test push</>}
    </button>
  )
}
