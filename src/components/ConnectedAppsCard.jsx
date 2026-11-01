'use client'

// MCP.1 — /account: the apps (Claude, over the CRM's MCP connector) this
// person has connected, with when each was last used and how often this week.
//
// The grants are the signed-in session's own, so they are read and revoked in
// the browser through supabase.auth.oauth (listGrants / revokeGrant). Usage
// comes from /api/account/connected-apps, keyed by the OAuth client id. A
// failed usage read leaves the grants (and Revoke) in place without numbers:
// the list is the part that matters.

import { useCallback, useEffect, useState } from 'react'
import { Plug } from 'lucide-react'
import { Button } from '@/components/ui'
import { createBrowserClient } from '@/lib/supabase'
import { formatRecordTime } from '@/lib/record-time'
import { useViewerZone } from '@/lib/use-viewer-zone'

const ENDPOINT = '/api/account/connected-apps'

export function stamp(iso, zone, viewerZone = null) {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return null
  return formatRecordTime(new Date(t), zone, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }, 'en-IE', viewerZone)
}

export default function ConnectedAppsCard({ connectorUrl, timezone = null }) {
  const viewerZone = useViewerZone()
  const [grants, setGrants] = useState(null) // null while loading
  const [usage, setUsage] = useState({})     // client_id -> { last_used_at, calls_7d }
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const { data, error: grantError } = await createBrowserClient().auth.oauth.listGrants()
      if (grantError || !Array.isArray(data)) throw grantError || new Error('listGrants returned no list')
      // A grant with no client id cannot be shown or revoked: skip it.
      setGrants(data.filter((g) => g?.client?.id))
    } catch {
      // A failed read is unknown, never "none": grants stay null so neither
      // the empty state nor a stale list (a revoked app) renders.
      setGrants(null)
      setError('Could not load your connected apps.')
      return
    }
    try {
      const res = await fetch(ENDPOINT, { cache: 'no-store' })
      const body = await res.json()
      if (body.success) {
        setUsage(Object.fromEntries(body.data.clients.map((c) => [c.client_id, c])))
      }
    } catch {
      // Usage is a nicety: the grants above stay usable without it.
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function revoke(grant) {
    const name = grant.client?.name || 'this app'
    if (!window.confirm(`Disconnect ${name}? It will stop being able to use the CRM on your behalf.`)) return
    setBusyId(grant.client.id)
    setError(null)
    try {
      const { error: revokeError } = await createBrowserClient().auth.oauth.revokeGrant({ clientId: grant.client.id })
      if (revokeError) {
        setError(`Could not disconnect ${name}. Try again.`)
        return
      }
      await load()
    } catch {
      setError(`Could not disconnect ${name}. Try again.`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="border-t border-un1t-border pt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Connected apps</h2>
      <div className="p-4 rounded-xl bg-un1t-surface border border-un1t-border">
        <div className="flex items-start gap-3">
          <Plug size={18} className="text-un1t-subtle mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-un1t-text">Apps that can use the CRM as you</div>
            <p className="text-xs text-un1t-subtle mt-1">
              An app you connect can only do what you can do here. Disconnect one and it stops straight away.
            </p>

            {error && <p role="alert" className="text-xs text-red-700 mt-2">{error}</p>}

            {grants && grants.length === 0 && (
              <p className="text-xs text-un1t-text mt-3">
                Nothing connected. Add the CRM in Claude from {connectorUrl}.
              </p>
            )}

            {grants && grants.length > 0 && (
              <ul className="mt-3 divide-y divide-un1t-border">
                {grants.map((g) => {
                  const u = usage[g.client.id]
                  const connected = stamp(g.granted_at ?? g.created_at, timezone, viewerZone)
                  const lastUsed = stamp(u?.last_used_at, timezone, viewerZone)
                  return (
                    <li key={g.client.id} className="py-3 first:pt-0 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-un1t-text">{g.client.name}</div>
                        {connected && <div className="text-xs text-un1t-subtle mt-0.5">Connected {connected}</div>}
                        {u ? (
                          <div className="text-xs text-un1t-subtle mt-0.5">
                            {lastUsed ? `Last used ${lastUsed}. ` : ''}{u.calls_7d} {u.calls_7d === 1 ? 'call' : 'calls'} in the last 7 days.
                          </div>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        loading={busyId === g.client.id}
                        disabled={busyId !== null}
                        onClick={() => revoke(g)}
                      >
                        Revoke
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
