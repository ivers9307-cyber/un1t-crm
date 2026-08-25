'use client'

// STAFF-DEV.8 — "Nudge to update" on the device-health page's fleet
// table header.
//
// Sends a push to the staff at this location whose CURRENT device is on
// a build below the fleet target. The list of recipients shown here is a
// preview, not an instruction: POST /api/staff-devices/nudge recomputes
// who is genuinely outdated server-side and intersects it with the ids
// we send, so nothing here can talk the server into nudging someone who
// is up to date. It also throttles to one nudge per device per 24h — a
// second click inside the window comes back as `skipped_throttled`
// rather than a second push.

import { useState } from 'react'
import { BellRing, AlertTriangle, Check } from 'lucide-react'
import { Button, Modal } from '@/components/ui'

// Mirrors the route's DEFAULT_BODY. Prefilled rather than hard-coded so
// the operator can say what the update actually contains.
const DEFAULT_MESSAGE =
  'Please update Repset from the App Store — your version is out of date.'

export default function NudgeUpdateButton({ recipients = [] }) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState(DEFAULT_MESSAGE)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  if (recipients.length === 0) return null

  async function send() {
    setSending(true)
    setError(null)
    try {
      const res = await fetch('/api/staff-devices/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile_ids: recipients.map((r) => r.id),
          // Only send copy that differs from the default — otherwise the
          // route's own wording stays the single source of truth.
          ...(message.trim() && message.trim() !== DEFAULT_MESSAGE
            ? { message: message.trim() }
            : {}),
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        setError(json.error || `HTTP ${res.status}`)
      } else {
        setResult(json.data)
        setOpen(false)
      }
    } catch (err) {
      setError(err.message || 'Network error')
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        {result && (
          <span className="inline-flex items-center gap-1 text-[11px] text-un1t-subtle">
            {result.sent > 0
              ? <Check size={12} className="text-emerald-700" />
              : <AlertTriangle size={12} className="text-amber-700" />}
            {result.sent} sent
            {result.skipped_throttled > 0 && <span>· {result.skipped_throttled} nudged today</span>}
            {result.skipped_no_app > 0 && <span>· {result.skipped_no_app} no app</span>}
            {/* ANDROID-VIS.1b — distinct from "no app": these people HAVE
                the app, it just cannot receive push yet (Android/FCM). */}
            {result.skipped_no_token > 0 && <span>· {result.skipped_no_token} no push token</span>}
          </span>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={BellRing}
          onClick={() => { setResult(null); setError(null); setOpen(true) }}
        >
          Nudge to update ({recipients.length})
        </Button>
      </div>

      <Modal
        open={open}
        onClose={() => { if (!sending) setOpen(false) }}
        title="Nudge staff to update"
        size="md"
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={sending}>
              Cancel
            </Button>
            <Button type="button" onClick={send} loading={sending}>
              Send
            </Button>
          </>
        }
      >
        <p className="text-sm text-un1t-subtle mb-3">
          A push goes to {recipients.length} staff member{recipients.length === 1 ? '' : 's'} whose
          current device is on an older build. Anyone already nudged in the last 24 hours is skipped
          automatically.
        </p>
        <ul className="text-sm text-un1t-text mb-4 space-y-1 max-h-48 overflow-y-auto">
          {recipients.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3">
              <span>{r.name}</span>
              <span className="text-[11px] text-un1t-muted">{r.version || 'no version'}</span>
            </li>
          ))}
        </ul>
        <label htmlFor="nudge-message" className="block text-xs text-un1t-subtle mb-1">
          Message
        </label>
        <textarea
          id="nudge-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          maxLength={200}
          className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm text-un1t-text"
        />
        <div className="text-[11px] text-un1t-muted mt-1">{message.length}/200</div>
        {error && (
          <div className="mt-3 bg-red-500/10 text-red-700 rounded-lg px-3 py-2 text-xs">{error}</div>
        )}
      </Modal>
    </>
  )
}
