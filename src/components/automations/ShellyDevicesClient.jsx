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
// AND IT NEVER CLAIMS ANYTHING IT DID NOT READ. "No devices adopted yet" is a
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
// SHELLYGROUPS.8 — THE PAGE IS GROUPS FIRST. Top to bottom: the toolbar, the
// "N devices on your Shelly account aren't set up here" banner, "New group",
// the group cards (sort_order, then name), the day preview, the devices that
// are in no group, the devices that are (collapsed: their group's card is the
// control), and then the Shelly account and Find devices panels.
//
//   GET /api/shelly/groups is the third read of the 30 s poll, under the same
//   last-good rule: a failed groups read keeps the cards on screen.
//
//   GET /api/shelly/discover is read ONCE per page open, the first time the
//   connection is live — never on the poll. It walks the whole Shelly account
//   on the shared 1 req/sec budget. A failed read just hides the banner: it is
//   a nudge, not a claim. The count is relay rows with `supported === true`
//   and `adopted == null`, less any this session has since adopted.
//
// Which source wins: /api/shelly/connection is authoritative WHEN IT
// SUCCEEDS. Until it ever has, the devices payload's `connection_status` is
// the only answer available — and it is allowed to say 'unknown', which is
// the whole point of carrying it.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, Plus, RefreshCw, Tag } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { fetchJson, errorText, jsonBody } from './shelly-fetch'
import ShellyConnectionPanel from './ShellyConnectionPanel'
import ShellyDiscoverPanel from './ShellyDiscoverPanel'
import ShellyDeviceCard from './ShellyDeviceCard'
import ShellyGroupCard from './ShellyGroupCard'
import ShellyDayPreview from './ShellyDayPreview'
import { MAX_GROUP_NAME } from '@/lib/shelly/schemas'

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

const NAME_TAKEN_COPY = 'A group with that name already exists'

const byOrderThenName = (a, b) =>
  (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name || '').localeCompare(String(b.name || ''))

/**
 * How many relay rows on the account could be adopted here and are not:
 * `supported === true` (null is "unknown", not a nudge) and `adopted == null`,
 * less any adopted this session since discover was read.
 */
export function unadoptedCount(rows, adoptedIds) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r?.supported === true
    && r.adopted == null
    && !adoptedIds?.has?.(`${r.device_id}_${r.channel}`)).length
}

const MSG_TONE = { error: 'text-red-700', warn: 'text-amber-700', ok: 'text-un1t-subtle' }

export default function ShellyDevicesClient({ locationName, locationTz, glofoxConnected, glofoxUnknown = false, canManageConnection }) {
  // Last GOOD payloads. Null means "has never loaded", NOT "empty".
  const [conn, setConn] = useState(null)
  const [dev, setDev] = useState(null)
  const [groups, setGroups] = useState(null)
  // Discover rows, read once (see the header). null = not read, or the read failed.
  const [discovered, setDiscovered] = useState(null)
  const discoverRan = useRef(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState(null)
  const [createBusy, setCreateBusy] = useState(false)
  const [showGrouped, setShowGrouped] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshError, setRefreshError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [cooling, setCooling] = useState(false)
  // ONE verdict slot, shared by Refresh and Use Shelly names. Two lines side
  // by side would leave a stale one standing next to a fresh one, and the two
  // actions are mutually exclusive anyway (each debounces the other out).
  const [refreshMsg, setRefreshMsg] = useState(null)
  // SHELLYALERTS.4 — a line a group card hands up (a deleted group's message:
  // the card is gone before its own result line could be read).
  const [groupMsg, setGroupMsg] = useState(null)
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
  const groupMsgTimer = useRef(null)
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
      if (groupMsgTimer.current) clearTimeout(groupMsgTimer.current)
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
    const [c, d, g] = await Promise.all([
      fetchJson('/api/shelly/connection'),
      fetchJson('/api/shelly/devices'),
      fetchJson('/api/shelly/groups'),
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
    if (g.ok && g.json?.success !== false) {
      setGroups(Array.isArray(g.json?.groups) ? g.json.groups : [])
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

  // Self-clearing, like the refresh verdict.
  function showGroupMsg(msg) {
    setGroupMsg(msg)
    if (groupMsgTimer.current) clearTimeout(groupMsgTimer.current)
    groupMsgTimer.current = setTimeout(() => { if (liveRef.current) setGroupMsg(null) }, REFRESH_MSG_MS)
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

  // Discover ONCE per page open, the first time the connection is live.
  const liveNow = (conn ? conn.connection?.status : dev?.connection_status) === 'connected'
  useEffect(() => {
    if (!liveNow || discoverRan.current) return
    discoverRan.current = true
    fetchJson('/api/shelly/discover').then((res) => {
      if (!liveRef.current) return
      if (res.ok && res.json?.success !== false && Array.isArray(res.json?.devices)) setDiscovered(res.json.devices)
    })
  }, [liveNow])

  async function createGroup(e) {
    e?.preventDefault?.()
    const name = newName.trim()
    if (!name) {
      setCreateError('Give the group a name')
      return
    }
    setCreateBusy(true)
    setCreateError(null)
    const res = await fetchJson('/api/shelly/groups', jsonBody('POST', { name }))
    if (!liveRef.current) return
    setCreateBusy(false)
    if (!res.ok || res.json?.success === false) {
      setCreateError(res.json?.code === 'name_taken' ? NAME_TAKEN_COPY : errorText(res.json, 'Could not create the group'))
      return
    }
    // On screen at once; the reload that follows replaces it with the
    // server's row (and its `now`). The load ticket drops any older poll.
    const created = res.json?.group
    if (created?.id) {
      setGroups((prev) => [...(prev || []).filter((x) => x.id !== created.id), created])
    }
    setCreating(false)
    setNewName('')
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
  const groupList = [...(groups || [])].sort(byOrderThenName)
  const groupById = new Map(groupList.map((g) => [g.id, g]))
  const ungrouped = devices.filter((d) => !d.group_id)
  const groupedDevices = devices.filter((d) => d.group_id)
  const missing = discovered ? unadoptedCount(discovered, adoptedIds) : 0

  if (loading && !conn && !dev) {
    return <p className="text-sm text-un1t-subtle">Loading {locationName || 'your studio'}&rsquo;s plugs…</p>
  }

  const deviceCard = (d) => (
    <ShellyDeviceCard
      key={d.id}
      device={d}
      group={d.group_id ? groupById.get(d.group_id) || null : null}
      connected={connected}
      locationTz={locationTz}
      glofoxConnected={glofoxConnected}
      glofoxUnknown={glofoxUnknown}
      onChanged={load}
    />
  )

  return (
    <div className="space-y-6">
      {/* ONE "retrying" line, never two. When the connection itself is the
          thing we could not read, the card below says so in the words that
          name what is unknown — a generic "couldn't refresh" stacked on top of
          it is the same news twice. */}
      {refreshError && !unreadable && (
        <p className="flex items-center gap-1 text-xs text-un1t-subtle" role="status">
          <AlertCircle size={12} aria-hidden="true" /> {refreshError}
        </p>
      )}

      {/* ——— toolbar ——————————————————————————————————————————————— */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-un1t-text">
            Lights and plugs{locationName ? ` · ${locationName}` : ''}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {refreshMsg && (
              <span className={`text-xs ${MSG_TONE[refreshMsg.tone] || MSG_TONE.ok}`} role="status">
                {refreshMsg.text}
              </span>
            )}
            {/* Gated on a LIVE connection, exactly like Find devices: this is
                an account-wide cloud read, and offering it against a
                connection we know is unusable buys a 409 the operator cannot
                act on from here. `connected` is null (not false) when it is
                our own read that failed, so an unreadable connection hides the
                button rather than claiming the account is broken. Nothing to
                name without plugs. */}
            {connected === true && devices.length > 0 && (
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
            {devices.length > 0 && (
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
            )}
          </div>
        </div>

        {/* TWO CHOICES, both spelled out — the destructive one says what it
            destroys in its own label. There is no undo: the replaced name is
            not kept anywhere. */}
        {syncOpen && connected === true && devices.length > 0 && (
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

      {/* ——— the nudge: devices on the account not set up here ——————————— */}
      {connected === true && missing > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <p className="text-sm text-amber-700">
            {missing} {missing === 1 ? 'device' : 'devices'} on your Shelly account {missing === 1 ? 'isn’t' : 'aren’t'} set up here
          </p>
          <a href="#shelly-discover" className="text-sm font-medium text-amber-700 underline">
            Set them up
          </a>
        </div>
      )}

      {/* ——— groups ———————————————————————————————————————————————— */}
      {status !== null && (
        <section className="space-y-3" aria-labelledby="shelly-groups-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="shelly-groups-heading" className="text-sm font-semibold text-un1t-text">Groups</h2>
            {!creating && (
              <Button size="sm" variant="secondary" icon={Plus} onClick={() => { setCreating(true); setCreateError(null) }}>
                New group
              </Button>
            )}
          </div>

          {groupMsg && (
            <p className={`text-xs ${MSG_TONE[groupMsg.tone] || MSG_TONE.ok}`} role="status">{groupMsg.text}</p>
          )}

          {creating && (
            <form onSubmit={createGroup} className="space-y-1 rounded-md border border-un1t-border bg-un1t-surface p-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={newName}
                  maxLength={MAX_GROUP_NAME}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setCreating(false); setNewName(''); setCreateError(null) } }}
                  placeholder="Studio lights"
                  aria-label="New group name"
                  className="min-w-0 flex-1 rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-sm text-un1t-text"
                />
                <Button size="sm" variant="primary" type="submit" loading={createBusy}>Create group</Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => { setCreating(false); setNewName(''); setCreateError(null) }}>
                  Cancel
                </Button>
              </div>
              {createError && <p className="text-xs text-red-700" role="alert">{createError}</p>}
            </form>
          )}

          {groups !== null && groupList.length === 0 && !creating && (
            <p className="text-sm text-un1t-subtle">
              No groups yet. A group switches several lights together and runs them on one schedule.
            </p>
          )}

          {groupList.length > 0 && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {groupList.map((g) => (
                <ShellyGroupCard
                  key={g.id}
                  group={g}
                  devices={devices}
                  groups={groupList}
                  connected={connected}
                  locationTz={locationTz}
                  glofoxConnected={glofoxConnected}
                  glofoxUnknown={glofoxUnknown}
                  onChanged={load}
                  onNotice={showGroupMsg}
                />
              ))}
            </div>
          )}

          {groupList.length > 0 && <ShellyDayPreview groups={groupList} tz={locationTz} />}
        </section>
      )}

      {/* ——— devices in no group ——————————————————————————————————— */}
      {/* Not drawn for a studio with no connection: there is nothing to list,
          and the Connect form below is the only thing to do. */}
      {(devices.length > 0 || (dev && status !== null)) && (
      <section className="space-y-3" aria-labelledby="shelly-ungrouped-heading">
        <h2 id="shelly-ungrouped-heading" className="text-sm font-semibold text-un1t-text">Not in a group</h2>

        {/* `dev` guards the CLAIM: "no plugs" is a fact about the studio, and
            we only have it when the devices read succeeded. */}
        {devices.length === 0 && dev && status !== null && (
          <p className="text-sm text-un1t-subtle">
            No devices adopted yet{connected === true ? ' — use Find devices below.' : '.'}
          </p>
        )}
        {devices.length > 0 && ungrouped.length === 0 && (
          <p className="text-sm text-un1t-subtle">Every device is in a group.</p>
        )}

        {ungrouped.length > 0 && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {ungrouped.map(deviceCard)}
          </div>
        )}
      </section>
      )}

      {/* ——— devices in a group: their group's card is the control, so these
          stay folded until asked for (rename, energy, one plug on its own). */}
      {groupedDevices.length > 0 && (
        <section className="space-y-3">
          <button
            type="button"
            onClick={() => setShowGrouped((v) => !v)}
            aria-expanded={showGrouped}
            className="inline-flex items-center gap-1 text-sm font-semibold text-un1t-text"
          >
            {showGrouped ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            Devices in groups ({groupedDevices.length})
          </button>
          {showGrouped && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {groupedDevices.map(deviceCard)}
            </div>
          )}
        </section>
      )}

      {/* ——— the account ———————————————————————————————————————————— */}
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
        {connected === true && (
          <div id="shelly-discover" className="scroll-mt-4">
            <ShellyDiscoverPanel adoptedIds={adoptedIds} onAdopted={load} />
          </div>
        )}
      </section>
    </div>
  )
}
