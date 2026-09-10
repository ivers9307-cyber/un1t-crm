'use client'

// WIDGET.1 — home-screen widget revocation card, staff detail page.
//
// Lists the widget credentials (one row per device) a staff member has set
// up, each with a Revoke button. GET /api/widget/tokens never returns
// token_hash — this card only ever sees id / device_label / created_at /
// last_used_at, which is exactly what it renders.
//
// Revoking is NOT a sign-out. DELETE /api/widget/tokens/[id] stamps
// revoked_at on that one row rather than touching a session, so only that
// one device's widgets go dead — door button included — while the phone
// app and every other device's widgets are untouched. The paragraph below
// the heading exists to make that door consequence obvious to the
// operator clicking Revoke, not just to explain the mechanism.
//
// Lazy-loads on mount, same pattern as ContactMarketingPreferencesCard /
// ConsultationsList: a `cancelled` flag in the effect cleanup so a fast
// profile switch (this card lives on a per-id detail page, but React can
// still re-run the effect on a prop change before the first fetch lands)
// can't let a stale GET's response land after a newer one and show the
// wrong profile's devices.

import { useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { Card, Button } from '@/components/ui'

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return d.toLocaleDateString('en-IE')
}

export default function WidgetTokensCard({ profileId }) {
  const [tokens, setTokens] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [revokingId, setRevokingId] = useState(null)
  const [revokeErrors, setRevokeErrors] = useState({})

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    async function load() {
      try {
        const r = await fetch(`/api/widget/tokens?profile_id=${profileId}`)
        const j = await r.json().catch(() => ({}))
        if (cancelled) return
        if (r.ok && j.success) {
          setTokens(j.data?.tokens || [])
        } else {
          setError(j.error || `Failed to load widgets (${r.status})`)
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Network error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [profileId])

  async function revoke(id) {
    setRevokingId(id)
    setRevokeErrors((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    try {
      const r = await fetch(`/api/widget/tokens/${id}`, { method: 'DELETE' })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.success) {
        setTokens((prev) => prev.filter((t) => t.id !== id))
      } else {
        setRevokeErrors((prev) => ({ ...prev, [id]: j.error || `Failed to revoke (${r.status})` }))
      }
    } catch (e) {
      setRevokeErrors((prev) => ({ ...prev, [id]: e?.message || 'Network error' }))
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <Card title="Home-screen widgets">
      <p className="text-xs text-un1t-subtle mb-3">
        Each row below is one device this person has added a UN1T home-screen widget
        to. Revoking a device kills every widget on it immediately — including its
        door button — without signing them out of the app itself. Use this if a
        phone is lost or stolen.
      </p>

      {loading && <p className="text-sm text-un1t-subtle">Loading…</p>}

      {!loading && error && (
        <p className="text-xs text-red-700 mb-3 flex items-center gap-1">
          <AlertCircle size={12} className="shrink-0" />
          {error}
        </p>
      )}

      {!loading && !error && tokens.length === 0 && (
        <p className="text-sm text-un1t-subtle">No widgets set up on any device.</p>
      )}

      {!loading && !error && tokens.length > 0 && (
        <ul className="divide-y divide-un1t-border/50">
          {tokens.map((t) => {
            const isRevoking = revokingId === t.id
            const rowError = revokeErrors[t.id]
            return (
              <li key={t.id} className="py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-un1t-text">
                      {t.device_label || 'Unnamed device'}
                    </div>
                    <div className="text-xs text-un1t-subtle">
                      Added {formatDate(t.created_at)}
                      {t.last_used_at ? ` · last used ${formatDate(t.last_used_at)}` : ' · never used'}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    loading={isRevoking}
                    disabled={isRevoking}
                    onClick={() => revoke(t.id)}
                  >
                    {isRevoking ? 'Revoking…' : 'Revoke'}
                  </Button>
                </div>
                {rowError && (
                  <p className="text-xs text-red-700 mt-1.5 flex items-center gap-1">
                    <AlertCircle size={12} className="shrink-0" />
                    {rowError}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
