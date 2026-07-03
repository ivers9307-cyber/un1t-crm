'use client'
// SendKudosCard.jsx — COACH KUDOS
//
// Compact composer for a coach to send a "kudo" (short congratulatory note +
// optional emoji) to a member. The member reads it in the champ app; there is
// no staff-side list here (write-only surface), so a successful send just
// shows a brief confirmation and clears the form.
//
// Props:
//   contactId  — string UUID of the recipient member
//   sessionId  — optional string UUID of an HR class session to tie the kudo to
//                (e.g. when rendered from a post-class view)
//
// POST → /api/contacts/[id]/kudos. Every non-submit button is type="button".

import { useState } from 'react'
import { Sparkles, AlertCircle, Check } from 'lucide-react'
import { Card, Button, Field } from '@/components/ui'

const MAX = 500

// Small quick-pick of on-brand kudos emoji. Tapping toggles selection.
const EMOJI_CHOICES = ['💪', '🔥', '👏', '⭐', '🙌']

export default function SendKudosCard({ contactId, sessionId = null }) {
  const [message, setMessage] = useState('')
  const [emoji, setEmoji] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [sent, setSent] = useState(false)

  const trimmed = message.trim()
  const tooLong = message.length > MAX
  const canSend = trimmed.length > 0 && !tooLong && !busy

  async function submit(e) {
    e.preventDefault()
    if (!canSend) return
    setBusy(true)
    setError(null)
    setSent(false)

    const body = {
      message: trimmed,
      emoji: emoji || undefined,
      session_id: sessionId || undefined,
    }

    try {
      const r = await fetch(`/api/contacts/${contactId}/kudos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setError(j.error || `Failed (${r.status})`)
        return
      }
      // Write-only surface — clear the form and flash a confirmation.
      setMessage('')
      setEmoji('')
      setSent(true)
    } catch (err) {
      setError(err?.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Send kudos">
      <p className="text-xs text-un1t-subtle mb-3">
        A short note of encouragement your member sees in their app.
      </p>
      <form onSubmit={submit} className="space-y-3">
        {error && (
          <p className="text-xs text-red-700 flex items-center gap-1">
            <AlertCircle size={12} className="shrink-0" />
            {error}
          </p>
        )}
        {sent && !error && (
          <p className="text-xs text-green-700 flex items-center gap-1">
            <Check size={12} className="shrink-0" />
            Kudos sent.
          </p>
        )}

        <Field id="kudos-message" label="Message">
          {(p) => (
            <textarea
              {...p}
              value={message}
              onChange={(e) => { setMessage(e.target.value); setSent(false) }}
              rows={3}
              maxLength={MAX}
              placeholder="Great work today — you smashed that session! 🎉"
              className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text"
            />
          )}
        </Field>

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            {EMOJI_CHOICES.map((e) => {
              const active = emoji === e
              return (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEmoji(active ? '' : e)}
                  aria-pressed={active}
                  aria-label={`Kudos emoji ${e}`}
                  className={
                    'flex h-8 w-8 items-center justify-center rounded-full text-base transition ' +
                    (active
                      ? 'bg-un1t-accent/10 ring-1 ring-un1t-accent'
                      : 'bg-un1t-bg hover:bg-un1t-border/40')
                  }
                >
                  {e}
                </button>
              )
            })}
          </div>
          <span className={'text-xs ' + (tooLong ? 'text-red-700' : 'text-un1t-subtle')}>
            {message.length}/{MAX}
          </span>
        </div>

        <div>
          <Button type="submit" size="sm" icon={Sparkles} loading={busy} disabled={!canSend}>
            Send kudos
          </Button>
        </div>
      </form>
    </Card>
  )
}
