// SHELLY-UI.6 — what is on this studio's Shelly account, and what can be
// adopted.
//
// Renders GET /api/shelly/discover verbatim. Every row is one RELAY CHANNEL,
// which is why the count says "N relays across M devices": a four-relay Pro
// 4PM is one device and four rows here, while the connection panel's
// `devices_seen` counts DEVICES. Two numbers that disagree on screen with no
// explanation read as a bug in one of them.
//
// THE CHIPS ARE THE ROUTE'S ANSWER, NOT AN INFERENCE. `adopted` is
// 'here' | 'elsewhere' | null and `elsewhere_location_name` is present ONLY
// when the holder is in the caller's own organisation — a foreign business is
// named nowhere, deliberately (tenancy rule, same as the connection refusal).
// So this file never composes a name of its own for the 'elsewhere' case.
//
// `supported` is a TRI-STATE and only an explicit false is a refusal: null
// means the device reported nothing to judge (usually an offline plug), and
// the adopt route allows those, so the button must too.

'use client'

import { useState } from 'react'
import { AlertCircle, Search } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { fetchJson, errorText, jsonBody } from './shelly-fetch'

// Keyed by the normaliser's own `reason` so a new one shows up as a missing
// title rather than as confident, wrong copy.
const UNSUPPORTED_TITLE = {
  gen1: 'Gen1 devices are not supported yet',
  no_switch: 'This device has no switch to control',
}

const CHIP = 'rounded-full px-2 py-0.5 text-[11px] font-medium'
const CHIP_GREY = `${CHIP} bg-un1t-muted/10 text-un1t-subtle`
const CHIP_AMBER = `${CHIP} bg-amber-500/10 text-amber-700`

const rowKey = (r) => `${r.device_id}_${r.channel}`

// The label a device carries when its own account gave us no name. Composed
// at render time and never stored — a synthesised name on the row would be
// indistinguishable from one a human chose.
const deviceLabel = (r) => r.name || `${r.model || 'Shelly'} · ${String(r.device_id || '').slice(-4)}`

export default function ShellyDiscoverPanel({ adoptedIds, onAdopted }) {
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [errorCode, setErrorCode] = useState(null)
  const [adopting, setAdopting] = useState(null)
  const [adoptError, setAdoptError] = useState(null)

  async function find() {
    setBusy(true)
    setError(null)
    setErrorCode(null)
    setAdoptError(null)
    const res = await fetchJson('/api/shelly/discover')
    setBusy(false)
    if (!res.ok || res.json?.success === false) {
      setErrorCode(res.json?.code ?? null)
      setError(errorText(res.json, 'Could not read your Shelly account'))
      return
    }
    setRows(res.json?.devices || [])
  }

  async function adopt(row) {
    setAdopting(rowKey(row))
    setAdoptError(null)
    const res = await fetchJson(
      '/api/shelly/devices',
      jsonBody('POST', { device_id: row.device_id, channel: row.channel }),
    )
    setAdopting(null)
    if (!res.ok || res.json?.success === false) {
      setAdoptError({ key: rowKey(row), message: errorText(res.json, 'Could not adopt this device') })
      return
    }
    onAdopted?.(res.json?.device)
  }

  // Grouped by device so a multi-relay unit reads as one thing with channels,
  // not as four unrelated plugs with the same name.
  const groups = []
  const byId = new Map()
  for (const r of rows || []) {
    let g = byId.get(r.device_id)
    if (!g) {
      g = { device_id: r.device_id, label: deviceLabel(r), gen: r.gen, rows: [] }
      byId.set(r.device_id, g)
      groups.push(g)
    }
    g.rows.push(r)
  }

  return (
    <Card
      title="Find devices"
      actions={<Button size="sm" variant="secondary" icon={Search} loading={busy} onClick={find}>Find devices</Button>}
    >
      {error && (
        <div className="space-y-1">
          <p className="flex items-start gap-1 text-xs text-red-700" role="alert">
            <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> {error}
          </p>
          {errorCode === 'key_rejected' && (
            <p className="text-xs text-un1t-subtle">Re-paste the cloud auth key in the Shelly account panel above.</p>
          )}
        </div>
      )}

      {rows === null && !error && (
        <p className="text-sm text-un1t-subtle">
          Look up everything on this studio&rsquo;s Shelly account, then adopt the relays you want to schedule.
        </p>
      )}

      {rows !== null && rows.length === 0 && (
        <p className="text-sm text-un1t-subtle">Nothing on this Shelly account yet.</p>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="space-y-3">
          {/* `rows.length`, which the route also publishes as `row_count` —
              they are the same number by construction (`row_count:
              devices.length`), and counting what is actually on screen means
              the sentence can never disagree with the list under it. The
              wording keeps it apart from the connection panel's
              `devices_seen`, which counts DEVICES. */}
          <p className="text-xs text-un1t-subtle">
            {rows.length} relay{rows.length === 1 ? '' : 's'} across {groups.length} device{groups.length === 1 ? '' : 's'}
          </p>
          {groups.map((g) => (
            <div key={g.device_id} className="rounded border border-un1t-border/60 p-2">
              <p className="text-sm font-medium text-un1t-text">
                {g.label}
                {g.gen ? <span className="ml-2 text-xs font-normal text-un1t-subtle">Gen {g.gen}</span> : null}
              </p>
              <div className="mt-2 space-y-1.5">
                {g.rows.map((r) => {
                  const key = rowKey(r)
                  // The route's answer wins; the locally-adopted set only fills
                  // in a row this session just adopted, before the next Find.
                  const adoptedHere = r.adopted === 'here' || adoptedIds?.has?.(key)
                  const canAdopt = !adoptedHere && r.adopted == null && r.supported !== false
                  return (
                    <div key={key} className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-un1t-text">Channel {r.channel}</span>
                      {adoptedHere && <span className={CHIP_GREY}>Adopted here</span>}
                      {!adoptedHere && r.adopted === 'elsewhere' && (
                        <span className={CHIP_AMBER}>
                          {r.elsewhere_location_name ? `In use at ${r.elsewhere_location_name}` : 'In use elsewhere'}
                        </span>
                      )}
                      {r.supported === false && (
                        <span className={CHIP_GREY} title={UNSUPPORTED_TITLE[r.reason] || 'This device is not supported yet'}>
                          Not supported yet
                        </span>
                      )}
                      {r.online === false && <span className={CHIP_GREY}>Offline</span>}
                      {canAdopt && (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="ml-auto"
                          loading={adopting === key}
                          onClick={() => adopt(r)}
                        >
                          Adopt
                        </Button>
                      )}
                      {adoptError?.key === key && (
                        <span className="basis-full text-xs text-red-700" role="alert">{adoptError.message}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
