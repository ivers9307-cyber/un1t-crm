// SHELLY-UI.6 — the root of /automations/shelly. Owns the two reads the whole
// page is built from and hands the pieces down.
//
//   GET /api/shelly/connection  → { connection, can_manage, device_count }
//   GET /api/shelly/devices     → { devices, connected, connection_status }
//
// A FAILED POLL KEEPS THE LAST GOOD RENDER. That is the contract, and it is
// the reason GET /api/shelly/connection answers 500 on a transient database
// error instead of `connection: null`: a live studio must never be handed
// "not connected". A client that blanked its own state on that 500 would
// re-create, one layer up, exactly the failure the route was changed to
// avoid — an owner staring at a Connect form, invited to re-paste a
// credential that is working perfectly. So every load REPLACES state only on
// success, and a failure adds a subordinate line and changes nothing else.
//
// AND IT NEVER CLAIMS ANYTHING IT DID NOT READ. "No plugs adopted yet" is a
// statement about the studio's hardware, so it is made only when the devices
// read actually succeeded (`dev` is non-null). Rendering it off a failed read
// would tell an operator their plugs are gone because our database hiccuped.
//
// THE CONNECTION HAS THREE STATES, NOT TWO:
//
//   null       genuinely never connected → the Connect form, no cards.
//   'unknown'  we could not read it → a card saying so. Never the Connect
//              form, never a red "Stale" grade (device-health caps at amber),
//              never disabled controls. GET /api/shelly/devices mints this on
//              purpose when the device list read fine and the connection row
//              did not.
//   a status   'connected' | 'action_needed' | 'error' — the real thing.
//
// Which source wins: /api/shelly/connection is authoritative WHEN IT
// SUCCEEDS. Until it ever has, the devices payload's `connection_status` is
// the only answer available — and it is allowed to say 'unknown', which is
// the whole point of carrying it.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { fetchJson, errorText } from './shelly-fetch'
import ShellyConnectionPanel from './ShellyConnectionPanel'
import ShellyDiscoverPanel from './ShellyDiscoverPanel'
import ShellyDeviceCard from './ShellyDeviceCard'

const POLL_MS = 30_000
// The refresh route spends the shared 1 req/sec Shelly account budget on
// every adopted device, so a held-down button would starve the studio next
// door mid-reconcile. Client-side only — the server has its own budget.
const REFRESH_DEBOUNCE_MS = 10_000
// Long enough to read, short enough that it is never mistaken for the state
// of a LATER refresh nobody ran.
const REFRESH_MSG_MS = 8_000

const REFRESH_FAILED = 'Couldn’t refresh — retrying'
const CONNECTION_UNREADABLE = 'Couldn’t read the Shelly connection — retrying'

/**
 * What a refresh actually did, said off all three counters rather than off
 * `refreshed` alone.
 *
 * `refreshed` counts rows whose state CHANGED — the deadband swallows a
 * wattmeter twitching in the third decimal — so zero is the healthy answer
 * for a studio nothing moved in, and "Refreshed 0 devices" read as a failure.
 * `read_failures` and `rate_limited` are the two ways it can be a partial
 * answer, and both are things the operator can act on.
 */
export function refreshSummary({ refreshed = 0, read_failures: readFailures = 0, rate_limited: rateLimited = 0 } = {}) {
  const parts = [refreshed > 0 ? `Updated ${refreshed} device${refreshed === 1 ? '' : 's'}` : 'No changes']
  // Only worth saying when it might EXPLAIN the nothing — a rate limit on a
  // refresh that still updated rows is invisible to the operator by design.
  if (!refreshed && rateLimited > 0) parts.push('Shelly was busy')
  if (readFailures > 0) parts.push(`${readFailures} couldn’t be read`)
  return { tone: readFailures > 0 ? 'warn' : 'ok', text: parts.join(' — ') }
}

const MSG_TONE = { error: 'text-red-700', warn: 'text-amber-700', ok: 'text-un1t-subtle' }

export default function ShellyDevicesClient({ locationName, locationTz, glofoxConnected, canManageConnection }) {
  // Last GOOD payloads. Null means "has never loaded", NOT "empty".
  const [conn, setConn] = useState(null)
  const [dev, setDev] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshError, setRefreshError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [cooling, setCooling] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState(null)
  const coolTimer = useRef(null)
  const msgTimer = useRef(null)
  // Monotonic load counter. Every load takes a ticket on the way in and
  // checks it is still the newest on the way out.
  const seqRef = useRef(0)
  const liveRef = useRef(true)

  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
      if (coolTimer.current) clearTimeout(coolTimer.current)
      if (msgTimer.current) clearTimeout(msgTimer.current)
    }
  }, [])

  const load = useCallback(async () => {
    // TWO REQUESTS CAN BE IN FLIGHT AT ONCE — the 30 s poll and a reload
    // fired by a mutation — and nothing makes them land in the order they
    // were sent. Without this ticket a slow poll issued BEFORE a toggle can
    // resolve AFTER it and repaint the pre-toggle row over the fresh one: the
    // plug visibly springs back to Off a second after the operator switched
    // it on, and the next tick silently corrects it. Last-issued wins, never
    // last-arrived.
    const seq = ++seqRef.current
    const [c, d] = await Promise.all([
      fetchJson('/api/shelly/connection'),
      fetchJson('/api/shelly/devices'),
    ])
    // Stale, or the component is gone: drop the whole payload rather than
    // setState half of it.
    if (seq !== seqRef.current || !liveRef.current) return

    let failed = false
    if (c.ok && c.json?.success !== false) {
      setConn({
        connection: c.json.connection ?? null,
        can_manage: Boolean(c.json.can_manage),
        device_count: typeof c.json.device_count === 'number' ? c.json.device_count : null,
      })
    } else {
      failed = true
    }
    if (d.ok && d.json?.success !== false) {
      setDev({
        devices: Array.isArray(d.json.devices) ? d.json.devices : [],
        connected: d.json.connected ?? null,
        // `undefined` would be indistinguishable from "never loaded" once it
        // is read back out, so an absent key normalises to null (= genuinely
        // not connected), which is what the route means by omitting it.
        connection_status: d.json.connection_status ?? null,
      })
    } else {
      failed = true
    }
    // Subordinate, and cleared the moment a poll works again.
    setRefreshError(failed ? REFRESH_FAILED : null)
    setLoading(false)
  }, [])

  useEffect(() => {
    let timer = null
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }
    const start = () => { if (!timer) timer = setInterval(load, POLL_MS) }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop()
      else { load(); start() }
    }
    load()
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [load])

  function showRefreshMsg(msg) {
    setRefreshMsg(msg)
    if (msgTimer.current) clearTimeout(msgTimer.current)
    // Self-clearing: a verdict left on screen becomes a claim about whatever
    // the operator does next.
    msgTimer.current = setTimeout(() => { if (liveRef.current) setRefreshMsg(null) }, REFRESH_MSG_MS)
  }

  async function doRefresh() {
    if (refreshing || cooling) return
    setRefreshing(true)
    setRefreshMsg(null)
    const res = await fetchJson('/api/shelly/refresh', { method: 'POST' })
    if (!liveRef.current) return
    setRefreshing(false)
    setCooling(true)
    coolTimer.current = setTimeout(() => { if (liveRef.current) setCooling(false) }, REFRESH_DEBOUNCE_MS)
    if (!res.ok || res.json?.success === false) {
      showRefreshMsg({ tone: 'error', text: errorText(res.json, 'Could not read your plugs just now') })
      return
    }
    showRefreshMsg(refreshSummary(res.json))
    await load()
  }

  // ——— what state is the connection in? ————————————————————————————
  // `undefined` = neither read has ever succeeded (still loading, or both
  // failed). It is NOT null: null is the confident "never connected" that
  // opens the Connect form.
  //
  // A stored row can never BE 'unknown' — shelly_connections.status is
  // CHECK-constrained to connected|action_needed|error (mig 562) — so the
  // value only ever arrives from the devices payload, and only when the
  // connection read itself failed. Which means `unknown` implies there is no
  // last-good connection to render, and it collapses into the same branch as
  // `undefined` below.
  const status = conn ? (conn.connection?.status ?? null) : (dev ? dev.connection_status : undefined)
  const unknown = status === 'unknown'
  const unreadable = status === undefined || unknown
  const connected = unreadable ? null : status === 'connected'
  const canManage = conn ? conn.can_manage : Boolean(canManageConnection)
  const devices = dev?.devices || []
  const deviceCount = conn && conn.device_count !== null ? conn.device_count : (dev ? devices.length : null)
  const adoptedIds = new Set(devices.map((d) => `${d.device_id}_${d.channel}`))

  if (loading && !conn && !dev) {
    return <p className="text-sm text-un1t-subtle">Loading {locationName || 'your studio'}&rsquo;s plugs…</p>
  }

  return (
    <div className="space-y-4">
      {/* ONE "retrying" line, never two. When the connection itself is the
          thing we could not read, the card below says so in the words that
          name what is unknown — a generic "couldn't refresh" stacked on top of
          it is the same news twice. */}
      {refreshError && !unreadable && (
        <p className="flex items-center gap-1 text-xs text-un1t-subtle" role="status">
          <AlertCircle size={12} aria-hidden="true" /> {refreshError}
        </p>
      )}

      <section className="space-y-4">
        {/* Keeps the heading order h1 → h2 → h3: the two panels below are
            Cards, and Card titles render as h3. */}
        <h2 className="sr-only">Shelly account</h2>
        {unreadable ? (
          <Card title="Shelly account">
            <p className="text-sm text-un1t-subtle">{CONNECTION_UNREADABLE}</p>
          </Card>
        ) : (
          <ShellyConnectionPanel
            connection={conn?.connection ?? null}
            canManage={canManage}
            deviceCount={deviceCount}
            onSaved={load}
            onDisconnected={load}
          />
        )}

        {connected === true && <ShellyDiscoverPanel adoptedIds={adoptedIds} onAdopted={load} />}
      </section>

      <section className="space-y-4">
        {devices.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-un1t-text">
              Plugs{locationName ? ` · ${locationName}` : ''}
            </h2>
            <div className="flex items-center gap-2">
              {refreshMsg && (
                <span className={`text-xs ${MSG_TONE[refreshMsg.tone] || MSG_TONE.ok}`} role="status">
                  {refreshMsg.text}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                icon={RefreshCw}
                loading={refreshing}
                disabled={cooling}
                title={cooling ? 'Just refreshed — give it a few seconds' : undefined}
                onClick={doRefresh}
              >
                Refresh
              </Button>
            </div>
          </div>
        )}

        {/* `dev` guards the CLAIM: "no plugs" is a fact about the studio, and
            we only have it when the devices read succeeded. */}
        {devices.length === 0 && dev && status !== null && (
          <p className="text-sm text-un1t-subtle">
            No plugs adopted yet{connected === true ? ' — use Find devices above.' : '.'}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {devices.map((d) => (
            <ShellyDeviceCard
              key={d.id}
              device={d}
              connected={connected}
              locationTz={locationTz}
              glofoxConnected={glofoxConnected}
              onChanged={load}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
