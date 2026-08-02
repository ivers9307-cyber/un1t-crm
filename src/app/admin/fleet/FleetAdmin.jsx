'use client'

// FLEET-CMD.1 — the operator surface for studio device actions.
//
// Three things this UI is deliberately careful about:
//
//  1. It never renders a button the API would refuse. Applicability (role) and
//     permission are both resolved server-side in page.js, so a coach simply
//     does not see Reboot rather than seeing it and being told no.
//
//  2. Shutdown requires the device name to be TYPED, and says plainly that the
//     Pi stays off until someone physically power-cycles it. It is the one
//     action a keyboard cannot undo — a Pi has no usable wake-on-LAN over WiFi.
//
//  3. A device that has been shut down stays visible in a standing list.
//     Suppressed devices never alert, by design, so a forgotten shutdown would
//     otherwise be invisible precisely because the feature is working.

import { useState } from 'react'
import { Button, Card, Modal, Field, EmptyState } from '@/components/ui'
import { ACTIONS, availableActions } from '@/lib/fleet-commands'

const STATE_CHIP = {
  ok: 'bg-green-500/10 text-green-700',
  unreachable: 'bg-red-500/10 text-red-700',
  service_down: 'bg-amber-500/10 text-amber-700',
}

const STATUS_CHIP = {
  succeeded: 'bg-green-500/10 text-green-700',
  failed: 'bg-red-500/10 text-red-700',
  rejected: 'bg-red-500/10 text-red-700',
  expired: 'bg-slate-500/10 text-slate-700',
  pending: 'bg-blue-500/10 text-blue-700',
  claimed: 'bg-blue-500/10 text-blue-700',
}

function timeAgo(iso) {
  if (!iso) return null
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (!Number.isFinite(mins)) return null
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export default function FleetAdmin({ devices, commands, locations, isMaster }) {
  const [busy, setBusy] = useState(null)
  const [confirming, setConfirming] = useState(null)
  const [typed, setTyped] = useState('')
  const [notice, setNotice] = useState(null)
  const [token, setToken] = useState(null)

  // Shut-down devices never alert, so they need somewhere to stay visible.
  const poweredOff = devices.filter((d) => d.health?.suppressed_until)

  async function issue(deviceName, action) {
    setBusy(`${deviceName}:${action}`)
    setNotice(null)
    try {
      const res = await fetch('/api/admin/fleet/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_name: deviceName, action }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setNotice({ tone: 'error', text: json.error || 'Could not issue the command' })
      } else {
        setNotice({
          tone: 'ok',
          text: `${ACTIONS[action].label} sent to ${deviceName}. `
            + 'It expires in 2 minutes if the device is offline.',
        })
      }
    } catch {
      setNotice({ tone: 'error', text: 'Could not reach the server' })
    } finally {
      setBusy(null)
      setConfirming(null)
      setTyped('')
    }
  }

  function onAction(device, action) {
    // Anything that can strand or disrupt gets a confirm step; only the
    // stranding class demands the name be typed.
    if (ACTIONS[action].danger === 'safe') return issue(device.device_name, action)
    setConfirming({ device, action })
    setTyped('')
  }

  async function rotateToken(deviceName) {
    setBusy(`${deviceName}:token`)
    try {
      const res = await fetch(`/api/admin/fleet/devices/${deviceName}/token`, { method: 'POST' })
      const json = await res.json()
      if (json.ok) setToken({ deviceName, value: json.token })
      else setNotice({ tone: 'error', text: json.error || 'Could not issue a token' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="p-6 space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Studio devices</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Remote actions for the Raspberry Pis driving the TVs and the heart-rate bridge.
        </p>
      </header>

      {notice && (
        <div className={`rounded-lg px-4 py-3 text-sm ${
          notice.tone === 'error'
            ? 'bg-red-500/10 text-red-700'
            : 'bg-green-500/10 text-green-700'
        }`}>
          {notice.text}
        </div>
      )}

      {poweredOff.length > 0 && (
        <Card>
          <div className="p-4">
            <h2 className="text-sm font-semibold text-amber-700">Powered off</h2>
            <p className="text-sm text-un1t-subtle mt-1">
              These devices will not raise alerts. Each one needs somebody to
              physically power it back on.
            </p>
            <ul className="mt-2 text-sm">
              {poweredOff.map((d) => (
                <li key={d.device_name}>
                  <span className="font-medium">{d.label || d.device_name}</span>
                  {' — off since '}
                  {timeAgo(d.health.state_since) || 'recently'}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {devices.map((device) => {
          const actions = availableActions(device.role, (key) => (
            key === 'fleet_admin' ? device.canAdmin : device.canRestart
          ))
          const state = device.health?.state
          return (
            <Card key={device.device_name}>
              <div className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{device.label || device.device_name}</p>
                    <p className="text-xs text-un1t-subtle">
                      {device.device_name}
                      {device.location ? ` · ${device.location}` : ''}
                      {device.role ? ` · ${device.role}` : ''}
                    </p>
                  </div>
                  {state && (
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                      STATE_CHIP[state] || 'bg-slate-500/10 text-slate-700'
                    }`}>
                      {state === 'ok' ? 'Online' : state.replace('_', ' ')}
                    </span>
                  )}
                </div>

                {!device.claimed && (
                  <p className="text-sm text-amber-700">
                    Discovered on the tailnet but not assigned to a studio yet.
                    {isMaster ? ' Assign it a location and role to enable actions.' : ''}
                  </p>
                )}

                {device.claimed && !device.hasToken && (
                  <p className="text-sm text-un1t-subtle">
                    No agent token issued — actions will expire undelivered until
                    the Pi has one.
                  </p>
                )}

                {actions.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {actions.map(({ action, label, danger }) => (
                      <Button
                        key={action}
                        type="button"
                        size="sm"
                        variant={danger === 'safe' ? 'secondary' : 'danger'}
                        loading={busy === `${device.device_name}:${action}`}
                        onClick={() => onAction(device, action)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                )}

                {isMaster && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    loading={busy === `${device.device_name}:token`}
                    onClick={() => rotateToken(device.device_name)}
                  >
                    {device.hasToken ? 'Rotate agent token' : 'Issue agent token'}
                  </Button>
                )}
              </div>
            </Card>
          )
        })}
      </div>

      <Card>
        <div className="p-4">
          <h2 className="text-sm font-semibold">Recent actions</h2>
          {commands.length === 0 ? (
            <EmptyState title="Nothing yet" description="Actions you take will be logged here." />
          ) : (
            <ul className="mt-2 divide-y divide-un1t-border text-sm">
              {commands.map((c) => (
                <li key={c.id} className="py-2 flex items-center justify-between gap-3">
                  <span>
                    <span className="font-medium">{ACTIONS[c.action]?.label || c.action}</span>
                    {' · '}{c.device_name}
                    {c.profiles?.full_name ? ` · ${c.profiles.full_name}` : ''}
                    {c.error ? <span className="text-red-700"> · {c.error}</span> : null}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-un1t-subtle">{timeAgo(c.issued_at)}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${
                      STATUS_CHIP[c.status] || 'bg-slate-500/10 text-slate-700'
                    }`}>
                      {/* 'succeeded' would be a lie for a shutdown: the device
                          is gone and is not coming back on its own. */}
                      {c.action === 'shutdown' && c.status === 'succeeded' ? 'halted' : c.status}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Modal
        open={Boolean(confirming)}
        onClose={() => { setConfirming(null); setTyped('') }}
        title={confirming ? `${ACTIONS[confirming.action].label} — ${confirming.device.label || confirming.device.device_name}` : ''}
      >
        {confirming && (
          <div className="space-y-4">
            <p className="text-sm">{ACTIONS[confirming.action].blurb}</p>

            {ACTIONS[confirming.action].danger === 'stranding' && (
              <>
                <div className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-700">
                  <strong>{confirming.device.device_name}</strong> will stay off
                  until someone physically power-cycles it. There is no way to
                  switch it back on remotely.
                </div>
                <Field label={`Type ${confirming.device.device_name} to confirm`}>
                  <input
                    className="w-full rounded-lg border border-un1t-border px-3 py-2 text-sm"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="off"
                  />
                </Field>
              </>
            )}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => { setConfirming(null); setTyped('') }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={
                  ACTIONS[confirming.action].danger === 'stranding'
                  && typed.trim() !== confirming.device.device_name
                }
                loading={busy === `${confirming.device.device_name}:${confirming.action}`}
                onClick={() => issue(confirming.device.device_name, confirming.action)}
              >
                {ACTIONS[confirming.action].label}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={Boolean(token)} onClose={() => setToken(null)} title="Agent token">
        {token && (
          <div className="space-y-3">
            <p className="text-sm">
              Copy this into <code>/etc/un1t-pi/agent.env</code> on{' '}
              <strong>{token.deviceName}</strong> as <code>FLEET_AGENT_TOKEN</code>,
              then restart the agent. It is shown once and cannot be retrieved again.
            </p>
            <pre className="rounded-lg bg-un1t-muted p-3 text-xs break-all whitespace-pre-wrap">
              {token.value}
            </pre>
            <div className="flex justify-end">
              <Button type="button" onClick={() => setToken(null)}>Done</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
