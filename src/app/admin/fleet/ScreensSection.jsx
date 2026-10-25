'use client'

// SCREENMODE.11 — the Android TV screens on /admin/fleet.
//
// Like the Pi list beside it, this draws what the server decided. page.js
// resolves `canOverride` (fleet_restart at the box's studio) and `isMaster`
// from the session, so no button renders that the API would refuse — the
// override route 404s anything the caller may not touch, and registration is
// master-only.
//
// "Should show" is `expectedMode` from expectedModesFor (src/lib/screen-plan.js):
// null means the studio's screen_mode automation is absent or disabled, or its
// reads failed, so there is no expectation to compare against; a device that an
// enabled studio's config does not list answers 'marketing'. A mismatch is only
// ever flagged when both sides are known.

import { useState } from 'react'
import { Button, Card, Field, EmptyState } from '@/components/ui'
import { timeAgo, timeUntil } from './time-ago'

const MODE_CHIP = {
  class_app: { label: 'Class app', tone: 'bg-blue-500/10 text-blue-700' },
  marketing: { label: 'Marketing', tone: 'bg-green-500/10 text-green-700' },
}
const UNKNOWN_CHIP = { label: 'Unknown', tone: 'bg-slate-500/10 text-slate-700' }

const INPUT = 'w-full rounded-lg border border-un1t-border px-3 py-2 text-sm'
const NO_DISPLAY = 'No display (box shows its own idle screen)'

function ModeChip({ mode }) {
  const chip = MODE_CHIP[mode] || UNKNOWN_CHIP
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${chip.tone}`}>{chip.label}</span>
  )
}

function ExpectedChip({ mode }) {
  if (mode === null || mode === undefined) {
    return (
      <span title="Class screens automation is off at this studio" className="text-un1t-subtle">—</span>
    )
  }
  return <ModeChip mode={mode} />
}

async function errorText(res) {
  try {
    const json = await res.json()
    if (json?.error) return String(json.error)
  } catch {
    // Not JSON (a proxy error page); fall through to the generic line.
  }
  return 'Could not complete that'
}

export default function ScreensSection({
  screens,
  locations,
  displays,
  isMaster,
  onChanged,
  onIssueToken,
  busy,
}) {
  const [pending, setPending] = useState(null)
  const [rowError, setRowError] = useState(null)

  const [deviceName, setDeviceName] = useState('')
  const [label, setLabel] = useState('')
  const [locationId, setLocationId] = useState('')
  const [displayId, setDisplayId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState(null)

  async function override(name, body, key) {
    setPending(`${name}:${key}`)
    setRowError(null)
    try {
      const res = await fetch(`/api/admin/fleet/devices/${encodeURIComponent(name)}/screen-override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setRowError({ name, text: await errorText(res) })
        return
      }
      onChanged()
    } catch {
      setRowError({ name, text: 'Could not reach the server' })
    } finally {
      setPending(null)
    }
  }

  async function register(e) {
    e.preventDefault()
    const name = deviceName.trim()
    if (!name || !locationId) return
    setSubmitting(true)
    setFormError(null)
    const body = { device_name: name, location_id: locationId, role: 'screen' }
    if (label.trim()) body.label = label.trim()
    if (displayId) body.tv_display_id = displayId
    try {
      const res = await fetch('/api/admin/fleet/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        setDeviceName('')
        setLabel('')
        setLocationId('')
        setDisplayId('')
        onChanged()
      } else if (res.status === 409) {
        setFormError('A device with that name already exists.')
      } else {
        setFormError(await errorText(res))
      }
    } catch {
      setFormError('Could not reach the server')
    } finally {
      setSubmitting(false)
    }
  }

  const displaysHere = displays.filter((d) => d.location_id === locationId)

  return (
    <Card>
      <div className="p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Screens</h2>
          <p className="text-sm text-un1t-subtle mt-1">
            The Android TV boxes. Each one asks the CRM what to show: the class
            app during a class, marketing otherwise.
          </p>
        </div>

        {screens.length === 0 ? (
          <EmptyState title="No screens registered" description="Register the first box below." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-un1t-subtle">
                  <th className="py-2 pr-3 font-medium">Device</th>
                  <th className="py-2 pr-3 font-medium">Where it hangs</th>
                  <th className="py-2 pr-3 font-medium">Display</th>
                  <th className="py-2 pr-3 font-medium">Last seen</th>
                  <th className="py-2 pr-3 font-medium">Showing</th>
                  <th className="py-2 pr-3 font-medium">Should show</th>
                  <th className="py-2 font-medium">Controls</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-un1t-border">
                {screens.map((s) => {
                  const mismatch = s.reportedMode === 'marketing' && s.expectedMode === 'class_app'
                  const ends = s.override ? timeUntil(s.override.until) : null
                  return (
                    <tr key={s.device_name} className="align-top">
                      <td className="py-2 pr-3">
                        <p className="font-medium">{s.label || s.device_name}</p>
                        <p className="text-xs text-un1t-subtle">
                          {s.device_name}
                          {s.reportedVersion ? ` · v${s.reportedVersion}` : ''}
                        </p>
                        {mismatch && (
                          <p className="text-xs text-amber-700">showing marketing during a class</p>
                        )}
                      </td>
                      <td className="py-2 pr-3">{s.location || '—'}</td>
                      <td className="py-2 pr-3">{s.displayLabel || '—'}</td>
                      <td className="py-2 pr-3">{timeAgo(s.lastHeartbeatAt) || 'Never'}</td>
                      <td className="py-2 pr-3"><ModeChip mode={s.reportedMode} /></td>
                      <td className="py-2 pr-3">
                        <ExpectedChip mode={s.expectedMode} />
                        {s.override && (
                          <p className="mt-1 text-xs text-un1t-subtle" title={s.override.until}>
                            Override: {(MODE_CHIP[s.override.mode] || UNKNOWN_CHIP).label}
                            {ends ? `, ends in ${ends}` : ''}
                          </p>
                        )}
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-2">
                          {s.canOverride && (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                loading={pending === `${s.device_name}:class_app`}
                                onClick={() => override(s.device_name, { mode: 'class_app', minutes: 60 }, 'class_app')}
                              >
                                Show class app for 1 h
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                loading={pending === `${s.device_name}:marketing`}
                                onClick={() => override(s.device_name, { mode: 'marketing', minutes: 60 }, 'marketing')}
                              >
                                Show marketing for 1 h
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                loading={pending === `${s.device_name}:clear`}
                                onClick={() => override(s.device_name, { clear: true }, 'clear')}
                              >
                                Back to schedule
                              </Button>
                            </>
                          )}
                          {isMaster && onIssueToken && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              loading={busy === `${s.device_name}:token`}
                              onClick={() => onIssueToken(s.device_name)}
                            >
                              {s.hasToken ? 'Rotate agent token' : 'Issue agent token'}
                            </Button>
                          )}
                        </div>
                        {rowError?.name === s.device_name && (
                          <p className="mt-1 text-xs text-red-700" role="alert">{rowError.text}</p>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {isMaster && (
          <form onSubmit={register} className="space-y-3 border-t border-un1t-border pt-4">
            <h3 className="text-sm font-semibold">Register a screen</h3>
            <div className="grid gap-3 md:grid-cols-2">
              <Field id="screen-device-name" label="Device name" hint="e.g. hatch-screen1">
                {(props) => (
                  <input
                    {...props}
                    className={INPUT}
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    autoComplete="off"
                  />
                )}
              </Field>
              <Field id="screen-label" label="Label" hint="Where it hangs">
                {(props) => (
                  <input
                    {...props}
                    className={INPUT}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    autoComplete="off"
                  />
                )}
              </Field>
              <Field id="screen-location" label="Location">
                {(props) => (
                  <select
                    {...props}
                    className={INPUT}
                    value={locationId}
                    onChange={(e) => { setLocationId(e.target.value); setDisplayId('') }}
                  >
                    <option value="">Choose a location</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                )}
              </Field>
              <Field id="screen-display" label="Display">
                {(props) => (
                  <select
                    {...props}
                    className={INPUT}
                    value={displayId}
                    onChange={(e) => setDisplayId(e.target.value)}
                  >
                    <option value="">{NO_DISPLAY}</option>
                    {displaysHere.map((d) => (
                      <option key={d.id} value={d.id}>{d.label}</option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            {formError && <p className="text-sm text-red-700" role="alert">{formError}</p>}
            <Button type="submit" size="sm" loading={submitting}>Register screen</Button>
          </form>
        )}
      </div>
    </Card>
  )
}
