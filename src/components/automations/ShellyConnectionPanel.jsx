// SHELLY-UI.6 — the Shelly account this studio controls its plugs through.
//
// Reads GET /api/shelly/connection's `connection` (publicConnectionView — host,
// key_hint, has_auth_key, status, last_ok_at, last_error, last_error_at) and
// writes through PUT/DELETE. The key itself is never in this component's props
// and never comes back from the server: `key_hint` is the last four characters
// and that is all the UI has ever seen.
//
// THREE THINGS THIS PANEL IS CAREFUL ABOUT, each because the route is:
//
//   * `devices_seen` may be NULL. probeConnection answers 0 for a genuinely
//     empty Shelly account and null for a body it could not count, so the
//     "N devices found" sentence is OMITTED for null rather than printed as a
//     zero that would send an operator hunting for plugs that are plainly
//     there.
//   * `status: 'error'` READS AS RETRYING, not as broken. A single blip parks
//     the connection for five minutes and the cron picks it up again;
//     'action_needed' is the one that needs a human, and it says exactly what
//     to do (re-paste).
//   * A 409 `verification_unavailable` is TRANSIENT (the fingerprint read
//     failed, so the link was refused out of caution) — it gets a Retry, not
//     the dead end the cross-org refusal gets.
//
// The Connect form is rendered ONLY for `connection === null`, which the
// parent passes only when the connection is genuinely absent. A connection we
// could not READ never reaches this component as null — see the header of
// ShellyDevicesClient.

'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, KeyRound, Link2Off, RefreshCw } from 'lucide-react'
import { Button, Card, Field } from '@/components/ui'
import { formatRelative } from '@/lib/dates'
import { fetchJson, errorText, jsonBody } from './shelly-fetch'

// Same recipe as the health chip (light theme: bg-<c>-500/10 text-<c>-700).
const STATUS_CHIP = {
  connected: { cls: 'bg-emerald-500/10 text-emerald-700', label: 'Connected' },
  action_needed: { cls: 'bg-amber-500/10 text-amber-700', label: 'Action needed — re-paste the key' },
  // Amber, NOT red: a transient cloud blip parks the row here and the cron
  // recovers on its own. Red would send an owner to re-paste a key that is
  // fine.
  error: { cls: 'bg-amber-500/10 text-amber-700', label: 'Retrying — Shelly unreachable' },
}

const HOST_PLACEHOLDER = 'shelly-68-eu.shelly.cloud'

export default function ShellyConnectionPanel({ connection, canManage, deviceCount, onSaved, onDisconnected }) {
  const linked = Boolean(connection)
  // The form is open by default when there is nothing to show yet.
  const [editing, setEditing] = useState(!linked)
  const [server, setServer] = useState(connection?.host || '')
  const [authKey, setAuthKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [errorCode, setErrorCode] = useState(null)
  const [saved, setSaved] = useState(null)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)

  // A connection APPEARING closes the form. It normally appears because this
  // panel just linked it, but it can also arrive on a poll (another admin, a
  // second tab), and leaving an open Connect form over a live connection
  // invites an owner to re-paste a credential that is working fine.
  useEffect(() => {
    if (linked) setEditing(false)
  }, [linked])

  // ——— read-only (manager, head coach, staff) ————————————————————————
  if (!canManage) {
    const chip = connection?.status ? STATUS_CHIP[connection.status] : null
    return (
      <Card title="Shelly account">
        <div className="flex flex-wrap items-center gap-2 text-sm text-un1t-subtle">
          {chip ? (
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${chip.cls}`}>{chip.label}</span>
          ) : (
            <span className="rounded-full bg-un1t-muted/10 px-2 py-0.5 text-xs font-medium text-un1t-subtle">
              Not connected
            </span>
          )}
          <span>Managed by the studio owner.</span>
        </div>
      </Card>
    )
  }

  async function submit(e) {
    e?.preventDefault?.()
    setBusy(true)
    setError(null)
    setErrorCode(null)
    setSaved(null)
    const res = await fetchJson('/api/shelly/connection', jsonBody('PUT', { server, auth_key: authKey }))
    setBusy(false)
    if (!res.ok || res.json?.success === false) {
      setErrorCode(res.json?.code ?? null)
      setError(errorText(res.json, 'Could not save the Shelly connection'))
      return
    }
    setAuthKey('')
    setEditing(false)
    setSaved({ devices_seen: res.json?.devices_seen ?? null, shared_with: res.json?.shared_with || [] })
    onSaved?.(res.json)
  }

  async function disconnect() {
    setBusy(true)
    setError(null)
    setErrorCode(null)
    const res = await fetchJson('/api/shelly/connection', { method: 'DELETE' })
    setBusy(false)
    setConfirmingDisconnect(false)
    if (!res.ok || res.json?.success === false) {
      setError(errorText(res.json, 'Could not disconnect the Shelly account'))
      return
    }
    setSaved(null)
    setEditing(true)
    setServer('')
    setAuthKey('')
    onDisconnected?.()
  }

  const chip = connection?.status ? STATUS_CHIP[connection.status] : null
  const plugCount = typeof deviceCount === 'number' ? deviceCount : null

  return (
    <Card title="Shelly account">
      {linked && !editing && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {chip && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${chip.cls}`}>{chip.label}</span>}
            <span className="text-xs text-un1t-subtle">
              {connection.host || 'no server on file'}
              {connection.key_hint ? ` · key ••••${connection.key_hint}` : ' · no key on file'}
              {connection.last_ok_at ? ` · last OK ${formatRelative(connection.last_ok_at)}` : ' · never confirmed'}
            </span>
          </div>
          {connection.status === 'error' && connection.last_error && (
            <p className="text-xs text-un1t-subtle">{connection.last_error}</p>
          )}
          {connection.status === 'action_needed' && connection.last_error && (
            <p className="text-xs text-amber-700">{connection.last_error}</p>
          )}
          {saved && (
            <p className="text-xs text-emerald-700">
              Connected
              {typeof saved.devices_seen === 'number' ? ` — ${saved.devices_seen} devices found` : ''}
              {saved.shared_with?.length ? `. Also used by ${saved.shared_with.join(', ')}.` : ''}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {/* Server prefilled from the row, key deliberately blank: the UI
                has never held the key, and a blank one keeps the stored one. */}
            <Button
              size="sm"
              variant="secondary"
              icon={KeyRound}
              onClick={() => { setServer(connection.host || ''); setAuthKey(''); setSaved(null); setError(null); setEditing(true) }}
            >
              Re-paste key
            </Button>
            {!confirmingDisconnect ? (
              <Button size="sm" variant="ghost" icon={Link2Off} onClick={() => setConfirmingDisconnect(true)}>
                Disconnect
              </Button>
            ) : (
              <span className="inline-flex flex-wrap items-center gap-2">
                {/* The count is dropped, not zeroed, when GET could not
                    compute it — "0 adopted plugs stay adopted" would read as
                    permission to disconnect a studio full of them. */}
                <span className="text-xs text-un1t-text">
                  {plugCount === null
                    ? 'Disconnect? Your adopted plugs stay adopted; control stops until you re-link.'
                    : `Disconnect? Your ${plugCount} adopted plug${plugCount === 1 ? '' : 's'} `
                      + `stay${plugCount === 1 ? 's' : ''} adopted; control stops until you re-link.`}
                </span>
                <Button size="sm" variant="danger" loading={busy} onClick={disconnect}>Disconnect</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmingDisconnect(false)}>Keep it</Button>
              </span>
            )}
          </div>
          {error && (
            <p className="flex items-center gap-1 text-xs text-red-700" role="alert">
              <AlertCircle size={12} aria-hidden="true" /> {error}
            </p>
          )}
        </div>
      )}

      {(!linked || editing) && (
        <form onSubmit={submit} className="space-y-3">
          {!linked && (
            <p className="text-sm text-un1t-subtle">
              Link this studio&rsquo;s Shelly Cloud account to schedule and switch its plugs.
            </p>
          )}
          <Field id="shelly-server" label="Server" hint="The Shelly Cloud server your account lives on.">
            {(props) => (
              <input
                {...props}
                type="text"
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder={HOST_PLACEHOLDER}
                autoComplete="off"
                className="w-full rounded border border-un1t-border bg-un1t-bg px-2 py-1.5 text-sm text-un1t-text"
              />
            )}
          </Field>
          <Field
            id="shelly-key"
            label="Authorization cloud key"
            // On a re-paste the stored key survives a blank field (the route's
            // secret merge), so the field is only required on the first link.
            required={!linked}
            hint={linked ? 'Leave blank to keep the key already on file.' : undefined}
          >
            {(props) => (
              <input
                {...props}
                type="password"
                value={authKey}
                onChange={(e) => setAuthKey(e.target.value)}
                autoComplete="off"
                className="w-full rounded border border-un1t-border bg-un1t-bg px-2 py-1.5 text-sm text-un1t-text"
              />
            )}
          </Field>

          <details className="rounded border border-un1t-border/60 p-2">
            <summary className="cursor-pointer text-xs font-medium text-un1t-text">Where to find these</summary>
            <div className="mt-2 space-y-1 text-xs text-un1t-subtle">
              <p>In the Shelly app: <strong>User settings → Authorization cloud key</strong>. That screen shows both the server and the key.</p>
              <p>Changing the Shelly account password invalidates the key — come back here and paste the new one.</p>
            </div>
          </details>

          {error && (
            <div className="space-y-1">
              <p className="flex items-start gap-1 text-xs text-red-700" role="alert">
                <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> {error}
              </p>
              {/* Transient, unlike the cross-org refusal — the fingerprint read
                  failed, so the same paste may well work a second later. */}
              {errorCode === 'verification_unavailable' && (
                <Button size="sm" variant="secondary" icon={RefreshCw} loading={busy} onClick={submit}>
                  Try again
                </Button>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" loading={busy}>{linked ? 'Save' : 'Connect'}</Button>
            {linked && (
              <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); setError(null); setAuthKey('') }}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}

      {!linked && saved && (
        <p className="mt-2 text-xs text-emerald-700">
          Connected
          {typeof saved.devices_seen === 'number' ? ` — ${saved.devices_seen} devices found` : ''}
          {saved.shared_with?.length ? `. Also used by ${saved.shared_with.join(', ')}.` : ''}
        </p>
      )}
    </Card>
  )
}
