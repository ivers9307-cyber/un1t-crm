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
import { AlertCircle, RefreshCw, Tag } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { fetchJson, errorText, jsonBody } from './shelly-fetch'
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

/**
 * SHELLY-NAMES.1 — what "Use Shelly names" actually did.
 *
 * `updated` is the only number an operator can see the effect of, so it leads.
 * `unresolved` is the interesting one for us — it means the account answered
 * and carried no label anywhere the resolver looks, which is exactly the live
 * failure this button was built for — so it is never folded into "no changes":
 * a plug that Shelly has no name for and a plug whose name already matches are
 * different answers, and only one of them needs looking at.
 */
export function syncNamesSummary({
  total = 0, updated = 0, unresolved = 0, write_failures: writeFailures = 0, partial = false,
} = {}) {
  const plugs = (n) => `${n} plug${n === 1 ? '' : 's'}`
  const parts = [
    updated > 0 ? `Named ${updated} of ${total}`
      : unresolved > 0 ? `No names found in Shelly for ${plugs(unresolved)}`
        : 'Names already match',
  ]
  // Only when it is not already the headline.
  if (updated > 0 && unresolved > 0) parts.push(`no name in Shelly for ${plugs(unresolved)}`)
  if (writeFailures > 0) parts.push(`${writeFailures} couldn’t be saved`)
  // A read that stopped short. Said out loud, because the counters describe
  // part of the location and would otherwise read as all of it.
  if (partial) parts.push('some plugs weren’t checked')
  return {
    tone: writeFailures > 0 || unresolved > 0 || partial ? 'warn' : 'ok',
    text: parts.join(' — '),
  }
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
  // ONE verdict slot, shared by Refresh and Use Shelly names. Two lines side
  // by side would leave a stale one standing next to a fresh one, and the two
  // actions are mutually exclusive anyway (each debounces the other out).
  const [refreshMsg, setRefreshMsg] = useState(null)
  // SHELLY-NAMES.1 — the name sync has its OWN in-flight and cooldown flags:
  // it spends the same shared 1 req/sec account budget as Refresh, so it gets
  // the same 10 s debounce, but sharing one flag would make either button
  // silently disable the other for reasons the operator cannot see.
  const [syncing, setSyncing] = useState(false)
  const [syncCooling, setSyncCooling] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const coolTimer = useRef(null)
  const syncCoolTimer = useRef(null)
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
      if (syncCoolTimer.current) clearTimeout(syncCoolTimer.current)
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

  /**
   * SHELLY-NAMES.1 — copy the labels from the Shelly app onto these rows.
   *
   * `overwrite` is never implicit: the two-choice confirm above this makes
   * "All plugs" a separate press, because it replaces names a human typed here
   * and nothing keeps the old one.
   */
  async function doSyncNames(overwrite) {
    if (syncing || syncCooling) return
    setSyncOpen(false)
    setSyncing(true)
    setRefreshMsg(null)
    const res = await fetchJson('/api/shelly/sync-names', jsonBody('POST', { overwrite }))
    if (!liveRef.current) return
    setSyncing(false)
    setSyncCooling(true)
    syncCoolTimer.current = setTimeout(() => { if (liveRef.current) setSyncCooling(false) }, REFRESH_DEBOUNCE_MS)
    if (!res.ok || res.json?.success === false) {
      // The route's 502 is PARTIAL by construction — it writes the names it
      // resolved before reporting the failure — so a bare error line would tell
      // an operator nothing happened when several plugs were in fact renamed.
      const line = errorText(res.json, 'Could not read the names from Shelly')
      const done = Number(res.json?.updated) || 0
      showRefreshMsg({ tone: 'error', text: done > 0 ? `Named ${done} — ${line}` : line })
      // Reload anyway: those names are on the rows now.
      if (done > 0) await load()
      return
    }
    showRefreshMsg(syncNamesSummary(res.json))
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
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-un1t-text">
                Plugs{locationName ? ` · ${locationName}` : ''}
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                {refreshMsg && (
                  <span className={`text-xs ${MSG_TONE[refreshMsg.tone] || MSG_TONE.ok}`} role="status">
                    {refreshMsg.text}
                  </span>
                )}
                {/* Gated on a LIVE connection, exactly like Find devices above:
                    this is an account-wide cloud read, and offering it against
                    a connection we know is unusable buys a 409 the operator
                    cannot act on from here. `connected` is null (not false)
                    when it is our own read that failed, so an unreadable
                    connection hides the button rather than claiming the
                    account is broken. */}
                {connected === true && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Tag}
                    loading={syncing}
                    disabled={syncCooling}
                    aria-expanded={syncOpen}
                    title={syncCooling ? 'Just synced — give it a few seconds' : undefined}
                    onClick={() => setSyncOpen((v) => !v)}
                  >
                    Use Shelly names
                  </Button>
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

            {/* TWO CHOICES, both spelled out — the destructive one says what it
                destroys in its own label. There is no undo: the replaced name
                is not kept anywhere. */}
            {syncOpen && connected === true && (
              <div
                className="flex flex-wrap items-center gap-2 rounded-md border border-un1t-border bg-un1t-surface p-2"
                role="group"
                aria-label="Use Shelly names"
              >
                <span className="text-xs text-un1t-subtle">Copy the names from your Shelly app to:</span>
                <Button size="sm" variant="secondary" onClick={() => doSyncNames(false)}>
                  Only unnamed plugs
                </Button>
                <Button size="sm" variant="danger" onClick={() => doSyncNames(true)}>
                  All plugs — replaces names typed here
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSyncOpen(false)}>
                  Cancel
                </Button>
              </div>
            )}
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
