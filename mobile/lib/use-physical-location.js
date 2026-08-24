// mobile/lib/use-physical-location.js
//
// HOME-LOC.5 — "which studio is this phone standing in", resolved on screen
// focus and then FROZEN for the visit (a GPS wobble must never swap which
// studio a thumb is about to command mid-screen). All decisions live in
// physical-location.js and physical-snapshot.js (pure, tested); this file
// only does IO.
//
// HOME-LOC.12 — the freeze breaks on two explicit events, both of which mean
// "the phone may have MOVED", which is not what the freeze guards against:
// an app FOREGROUND while the screen is focused (spec §2), and refresh().
//
// Never REQUESTS location permission — it reads the existing grant. The
// attendance gate owns the permission ask; a denied user simply never gets
// the on-site flip and Home renders its offsite layout (which needs no
// location at all).
//
// Status: 'loading' → exactly one of 'at_studio' | 'offsite' | 'unknown'.
// Returns { status, location, foregroundPermission, hasRegions, lastVerdict,
// refresh } — foregroundPermission ('granted'|'ask'|'settings'|'unknown')
// feeds Home's enable-location nudge (LOC-NUDGE.1); lastVerdict feeds Home's
// optimistic tiles (HOME-FAST.1); refresh() is the explicit re-resolve a
// pull-to-refresh calls (HOME-LOC.8b). Nothing else re-reads within a visit
// except an app foreground (HOME-LOC.12), which is the freeze this hook
// exists for.
//
// HOME-FAST.1 — COLD-START SPEED. Reopening the app at the studio used to
// serialise auth → region fetch → an indoor GPS acquisition behind a bare
// spinner. Three changes, all of them about painting from something already
// known while the authoritative answer catches up:
//   1. Position reads are TIERED by freshness (readPosition below), cheapest
//      first, with a full acquisition as the last resort rather than the
//      first move.
//   2. The regions, the last accepted fix and the last at_studio verdict are
//      PERSISTED across launches (physical-cache.js) and hydrated once per
//      module load, so a warm relaunch resolves with no network wait.
//   3. The hydrated verdict is exposed as `lastVerdict` so Home can paint
//      that studio's tiles under a grey "detecting…" pill while the real
//      resolution runs. It NEVER claims 'detected' — see Home for why a
//      mid-detection tap is safe.

import { useCallback, useRef, useState } from 'react'
import { AppState } from 'react-native'
import * as Location from 'expo-location'
import { useFocusEffect } from 'expo-router'
import { api } from './api'
import { useAuth } from './auth-context'
import { resolvePhysicalLocation, pickPosition, pickFresherLastKnown, mapForegroundPermission } from './physical-location'
import { freshVerdict, verdictFromResult, EMPTY_SNAPSHOT, REGIONS_MAX_AGE_MS } from './physical-snapshot'
import { readPhysicalSnapshot, writePhysicalSnapshot, clearPhysicalCaches } from './physical-cache'

const CONFIG_TTL_MS = 5 * 60 * 1000
const CONFIG_TIMEOUT_MS = 10000
const POSITION_TIMEOUT_MS = 8000
// Well inside pickPosition's 5-minute staleness gate, so a cache hit can
// never resurrect a fix that module would have rejected.
const POSITION_TTL_MS = 45 * 1000

// Module-level config cache: five screens resolve on focus; the regions
// change ~never. Kept on failure — a blip must not blind detection.
let regionsCache = { at: 0, regions: null }

// Module-level position cache. Without it, Home → Sonos → Home → Shelly is
// four Balanced GPS acquisitions and four loading repaints for one walk
// across one room. The VERDICT is deliberately not cached HERE — every focus
// re-resolves (regions and `locations` may have changed, and re-deciding is
// free) — only the expensive radio read is shared. (The PERSISTED verdict
// below is a different thing: it paints, it never resolves.)
let positionCache = { at: 0, position: null }

// The one-shot hydrate of the persisted snapshot, and the generation that
// invalidates it. A hydrate read in flight when sign-out lands must not seed
// the NEXT user from the previous user's disk snapshot, so the read checks
// the generation it started in before seeding anything — the same
// stale-answer guard as the visit counter in the hook below.
let hydratePromise = null
let cacheGeneration = 0

// In-flight geofence-config request, so the stale-while-revalidate refresh
// below cannot double-fire when several screens resolve on the same focus.
let regionsInFlight = null

// Write ordering for the persisted snapshot. Resolves overlap — five screens
// resolve on focus, and a pull-to-refresh deliberately runs one while a focus
// resolve is still in flight — and they finish OUT of order. In memory the
// hook's visit counter already refuses a late answer; the DISK had no such
// guard, so a slow focus resolve could land after a newer refresh() and
// re-write the verdict the newer one had just cleared. Each resolve takes a
// sequence number and claims the write; a claim by a higher sequence makes
// every lower one stale. Newest answer wins, not last-to-return.
let resolveSeq = 0
let lastSnapshotSeq = 0

/**
 * Read the persisted snapshot ONCE per module load and seed the module
 * caches from it. Awaited at the top of every resolve; every later call gets
 * the same promise, so this costs one keychain read per app launch.
 *
 * The regions are seeded with the snapshot's OWN `at`, not `Date.now()` —
 * that is what makes fetchRegions treat day-old-but-usable regions as
 * stale-but-present (paint now, revalidate in the background) rather than as
 * fresh (never revalidate).
 */
function hydrateOnce() {
  if (!hydratePromise) {
    const gen = cacheGeneration
    hydratePromise = readPhysicalSnapshot()
      .then((snap) => {
        if (gen !== cacheGeneration) return EMPTY_SNAPSHOT
        // Never overwrite a cache this session has already filled: anything
        // resolved in-process is newer than anything on disk.
        if (snap.regions && !regionsCache.regions) regionsCache = { at: snap.at, regions: snap.regions }
        return snap
      })
      .catch(() => EMPTY_SNAPSHOT)
  }
  return hydratePromise
}

/**
 * Drop every cache — the two module-level ones AND the persisted snapshot
 * (plus Home's persisted shifts, which physical-cache.js owns). Registered
 * in the sign-out teardown union (lib/sign-out.js): they would otherwise
 * outlive the session on a shared studio device — the next user would
 * resolve against the previous user's regions and, worse, their last
 * position fix, and Home would paint their roster.
 *
 * ASYNC since HOME-FAST.1 (the SecureStore deletes) — sign-out.js awaits it.
 */
export async function clearPhysicalLocationCaches() {
  regionsCache = { at: 0, regions: null }
  positionCache = { at: 0, position: null }
  // Bumping the generation neutralises a hydrate read that is already in
  // flight; nulling the promise lets the next resolve start a fresh one
  // (which, after the delete below, reads nothing).
  cacheGeneration += 1
  hydratePromise = null
  regionsInFlight = null
  // The sequence is per-session too: leaving it high would let a stale claim
  // block the first genuine write of the next session.
  lastSnapshotSeq = 0
  await clearPhysicalCaches()
}

/**
 * The network read, de-duplicated. Never throws — worst case, last good.
 * Resolves to a {regions, at} PAIR: the regions and the moment they were
 * obtained, together. Callers must never re-read `regionsCache.at` later to
 * pair with regions they captured earlier — a background refresh landing in
 * between would stamp the OLD list with the NEW time and stretch its 24h
 * life towards 48.
 */
function refreshRegions() {
  if (regionsInFlight) return regionsInFlight
  // The generation this read belongs to. A sign-out during the request must
  // not let it re-seed the module cache for whoever signs in next.
  const gen = cacheGeneration
  const inFlight = (async () => {
    try {
      // No impersonation guard, unlike geofence.js's syncGeofences(): this
      // read REGISTERS nothing and STAMPS nothing — it only asks "what are
      // the region coordinates". During View-as the config comes back as the
      // target, which is the same reality the rest of the screen already
      // renders (spec §2: position is the real device's, filtering is the
      // impersonated profile's), and the resolved location is then
      // intersected with the visible `locations` anyway.
      const res = await api('/api/attendance/geofence-config')
      if (res?.success) {
        // all_regions is exemption-blind (HOME-LOC.1); `regions` fallback only
        // covers a stale server during the deploy window.
        const regions = res.data?.all_regions ?? res.data?.regions ?? []
        const pair = { regions, at: Date.now() }
        // Seed only if this read still belongs to the current session.
        if (gen === cacheGeneration) regionsCache = pair
        return pair
      }
    } catch { /* fall through to last good */ }
    // Last good, read as ONE pair — never regions from here and `at` from
    // a later read.
    return { regions: regionsCache.regions || [], at: regionsCache.at }
  })()
  regionsInFlight = inFlight
  // Only clear the slot if it is still OURS — a teardown may have replaced it.
  inFlight.finally(() => { if (regionsInFlight === inFlight) regionsInFlight = null })
  return inFlight
}

/**
 * STALE-WHILE-REVALIDATE (HOME-FAST.1). Three tiers:
 *   TTL-fresh (≤5 min)      → return, no network at all.
 *   stale but ≤24h          → return the stale regions IMMEDIATELY and
 *                             revalidate in the background. This is what
 *                             makes a warm relaunch resolve with zero network
 *                             wait: the regions are a map of buildings that
 *                             changes when someone edits a geofence by hand,
 *                             so a day-old copy is worth painting with.
 *   absent or older         → await the network, as before.
 *
 * Returns the {regions, at} pair, captured atomically from the cache — the
 * caller persists both together (see resolveOnce).
 */
async function fetchRegions() {
  // ONE read of the cache object, so the regions and their stamp cannot come
  // from either side of a background refresh landing mid-function.
  const cached = regionsCache
  if (cached.regions) {
    // Math.abs, like every other age check here: a backwards clock change
    // must not make a stale cache look fresh (or vice versa).
    const age = Math.abs(Date.now() - cached.at)
    if (age <= CONFIG_TTL_MS) return { regions: cached.regions, at: cached.at }
    if (age <= REGIONS_MAX_AGE_MS) {
      // Fire-and-forget: it updates the cache for the NEXT resolve. It never
      // rejects (see refreshRegions), the .catch is belt-and-braces.
      refreshRegions().catch(() => {})
      return { regions: cached.regions, at: cached.at }
    }
  }
  return refreshRegions()
}

/** Bound a promise that has no cancellation of its own. `label` is the
 *  rejection message — both call sites below would otherwise report the
 *  other one's failure. */
function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

/** Tier 2 — the OS's cached fix and the one we persisted at the end of the
 *  previous launch, whichever is fresher and passes pickPosition's gate. An
 *  accepted fix populates the 45s cache: the other four screens must not each
 *  repeat the read. */
async function readLastKnown(persisted) {
  const osLastKnown = await Location.getLastKnownPositionAsync().catch(() => null)
  const lastKnown = pickFresherLastKnown({ osLastKnown, persisted, nowMs: Date.now() })
  if (lastKnown) positionCache = { at: Date.now(), position: lastKnown }
  return lastKnown
}

/** Tier 3 — the real read. Returns null on timeout, failure, or a fix that
 *  pickPosition rejects; every caller has a fallback for that. */
async function acquirePosition() {
  try {
    const current = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      POSITION_TIMEOUT_MS,
      'position timeout'
    )
    // Only cache a fix pickPosition would actually accept — a stale/replayed
    // read would otherwise pin every screen at 'unknown' for the full TTL
    // instead of retrying next focus.
    const fresh = pickPosition({ current, nowMs: Date.now() })
    if (fresh) positionCache = { at: Date.now(), position: fresh }
    return fresh
  } catch {
    return null
  }
}

/**
 * HOME-FAST.1 — the position read, TIERED BY FRESHNESS, cheapest tier first.
 * Every tier's answer goes through pickPosition, so nothing here can widen
 * the 5-minute staleness gate; the tiers only decide how much work we do
 * before asking the radio.
 *
 *   1. positionCache (≤45s, in-process)  — one walk across one room must not
 *      cost four acquisitions across four screens.
 *   2. LAST-KNOWN — the OS's cached fix and our persisted one, fresher wins.
 *   3. getCurrentPositionAsync, bounded by POSITION_TIMEOUT_MS.
 *
 * The ORDER of 2 and 3 is the reversal this ticket is about. Acquisition used
 * to come first, with lastKnown only as a fallback on failure — and indoors,
 * at the studio, in a steel-framed gym, that acquisition is exactly where a
 * cold start spends its seconds, behind a bare spinner, to learn what the OS
 * already knew. Nothing is loosened by preferring it: pickPosition's 5-minute
 * gate bounds how stale an accepted fix can be either way, and this is the
 * SAME data the old fallback already trusted — it is only trusted sooner. A
 * rejected last-known still falls through to a real acquisition, which is the
 * only case that now costs what every case used to.
 *
 * `forceFresh` REORDERS the tiers; it does not delete any.
 */
async function readPosition({ persisted, forceFresh }) {
  if (forceFresh) {
    // The radio first, for the two explicit "I may have MOVED" signals
    // (pull-to-refresh, a foreground after time away) — a last-known fix
    // cannot answer them, so it must not pre-empt the read.
    //
    // But when that acquisition FAILS, last-known is still a better answer
    // than none. An 8s timeout indoors is routine — it is the whole reason
    // this ticket exists — and main fell back to lastKnown on exactly that
    // failure. Returning null here instead would resolve 'unknown' and flip
    // Home to its OFFSITE layout for a phone standing in the studio, while
    // also clearing the persisted verdict: strictly worse than main, in the
    // ticket's own scenario. The 45s cache stays skipped either way; it is
    // the one thing the gesture explicitly disputes.
    return (await acquirePosition()) || (await readLastKnown(persisted))
  }

  // Tier 1. Re-gated rather than trusted: the cache stores the fix's own
  // timestamp, and 45s of TTL on top of an already-aging fix can cross the
  // 5-minute line.
  if (positionCache.position && Math.abs(Date.now() - positionCache.at) <= POSITION_TTL_MS) {
    const cached = pickPosition({ current: positionCache.position, nowMs: Date.now() })
    if (cached) return cached
  }

  // Tiers 2 then 3.
  return (await readLastKnown(persisted)) || (await acquirePosition())
}

// The whole IO path, hoisted out of the focus effect (HOME-LOC.8b) so the
// explicit refresh() below runs the SAME resolution rather than a second
// copy that could drift from it. Never throws — every failure lands on
// 'unknown', which renders the offsite layout.
async function resolveOnce(locations, { forceFresh = false } = {}) {
  // foregroundPermission rides along for Home's enable-location nudge
  // (LOC-NUDGE.1): 'unknown' until the read lands, so the nudge can never
  // fire off an unread or unreadable permission.
  let next = { status: 'unknown', location: null, foregroundPermission: 'unknown', hasRegions: false }
  let regions = []
  // Paired with `regions` from the same read — never re-derived later.
  let regionsAt = 0
  let position = null
  // The session this resolve belongs to. Everything it writes — the snapshot
  // below — is skipped if a sign-out lands first: an in-flight resolve must
  // not re-create the file the teardown just deleted, with the previous
  // user's fix and verdict in it. (The in-MEMORY result is guarded by the
  // caller's visit counter; the DISK was not guarded at all before this.)
  const gen = cacheGeneration
  const seq = ++resolveSeq
  try {
    // Before anything else: the persisted snapshot seeds regionsCache, so the
    // fetchRegions call below can answer from disk instead of the network.
    const snapshot = await hydrateOnce()
    const [perm, fetched] = await Promise.all([
      Location.getForegroundPermissionsAsync().catch(() => null),
      // api() builds on a bare fetch with no AbortSignal, so a hung
      // request would otherwise pin this hook at 'loading' until the
      // platform socket timeout — re-armed on every focus. The
      // abandoned fetch still populates regionsCache if it lands, so
      // the next focus gets the answer.
      withTimeout(fetchRegions(), CONFIG_TIMEOUT_MS, 'geofence-config timeout')
        // One expression, so the fallback pair is also atomic.
        .catch(() => ({ regions: regionsCache.regions || [], at: regionsCache.at })),
    ])
    regions = fetched.regions
    regionsAt = fetched.at
    next.foregroundPermission = mapForegroundPermission(perm)
    // hasRegions rides along for the nudge too: with no configured geofence
    // anywhere, granting permission could not deliver the on-site Home, so
    // the card must not promise it. A failed/timed-out config fetch reads as
    // false — the safe direction for a promise.
    next.hasRegions = regions.length > 0
    if (perm?.status === 'granted' && regions.length > 0) {
      position = await readPosition({ persisted: snapshot.position, forceFresh })
      next = { ...resolvePhysicalLocation({ position, regions, locations }), foregroundPermission: 'granted', hasRegions: true }
    }
  } catch { /* stays unknown */ }
  // Fire-and-forget persist of what this resolve learned, for the NEXT
  // launch (writePhysicalSnapshot swallows its own failures — an unwritable
  // keychain costs a head start, never a screen).
  //
  // What it does with the VERDICT is a three-way decision made in
  // physical-snapshot.js: at_studio writes it, a CONFIRMED offsite clears
  // it, and 'unknown' leaves what is on disk alone — "could not tell" (no
  // permission, no regions, no fix, offline) is not evidence that the phone
  // has moved, and throwing the verdict away there costs the next launch its
  // head start for nothing.
  //
  // `regionsAt` is the stamp that came back WITH these regions, not a later
  // re-read of the cache: a background refresh landing in between would
  // otherwise stamp this (older) list with the newer time and stretch its
  // 24h life. An offline launch re-persisting what it read from disk keeps
  // the original provenance for the same reason.
  //
  // isStale covers BOTH races, and is evaluated INSIDE the write, as late as
  // it can be: a sign-out landing while this is in flight (generation), and a
  // NEWER resolve having already claimed the write (sequence) — this one is
  // then an older answer and must not overwrite it.
  const isStale = () => gen !== cacheGeneration || seq < lastSnapshotSeq
  if (!isStale()) lastSnapshotSeq = seq
  writePhysicalSnapshot({ regions, regionsAt, position, result: next, isStale, nowMs: Date.now() })
  return next
}

export function usePhysicalLocation() {
  const { profile, locations } = useAuth()
  const [result, setResult] = useState({ status: 'loading', location: null, foregroundPermission: 'unknown', hasRegions: false })
  const visitRef = useRef(0)
  // HOME-FAST.1 — the last CONFIRMED at_studio answer, hydrated from disk on
  // mount and then owned by the resolves. Deliberately NOT part of `result`:
  // `result` goes back to 'loading' on every focus (the freeze), and this is
  // the one thing that must survive that reset — it is what Home paints
  // WHILE loading. It is never a claim of detection; the pill it feeds is
  // grey ("detecting…"), and the moment a real answer lands it is replaced
  // (at_studio) or cleared (offsite/unknown), so a wrong guess lives for the
  // length of one resolution and nothing acts on it in the meantime.
  const [verdict, setVerdict] = useState(null)
  // Has a live resolve landed in this hook instance? Once one has, the
  // hydrated verdict must never be seeded over it — the disk copy is by
  // definition older than anything this session resolved.
  const resolvedRef = useRef(false)

  // Read through a ref, not the closure. The effect below is keyed on the
  // id SET (see locationIds), so the captured array would otherwise be
  // whichever one was current at the last id-set change — and the location
  // OBJECTS inside it carry the per-location feature flags the on-site
  // tiles gate on, which a /me refresh can legitimately update without the
  // id set moving at all.
  const locationsRef = useRef(locations)
  locationsRef.current = locations

  // Key the effect on the assignment SET, not the array identity.
  // auth-context re-runs setLocations() on every /me refresh — boot, token
  // refresh, View-as, location switch — minting a NEW array each time with
  // identical contents. Keying on `locations` itself would therefore tear
  // the effect down and re-run it MID-VISIT on a background token refresh:
  // a loading flash and a second GPS read on a screen the user is already
  // looking at, i.e. exactly the mid-screen flip the freeze exists to
  // prevent. A change of the id set IS a change of reality and SHOULD
  // re-resolve. `profile?.id` rides along for the same reason: it is what
  // re-arms the effect once the gate below opens (and it flips on View-as).
  // Same `ids.join(',')` idiom as staff/roles/[id].jsx.
  const locationIds = (locations || []).map((l) => l?.id).sort().join(',')

  // The result of a resolve, applied as ONE commit: the status and the
  // verdict must move together, or Home renders one studio's tiles under
  // another studio's state for a frame. Stable (setState setters only), so
  // it cannot churn the effect or refresh() below.
  const land = useCallback((next) => {
    resolvedRef.current = true
    setResult(next)
    setVerdict(verdictFromResult(next, Date.now()))
  }, [])

  useFocusEffect(
    useCallback(() => {
      const visit = ++visitRef.current
      let active = true
      const fresh = () => active && visitRef.current === visit

      async function resolve() {
        const next = await resolveOnce(locationsRef.current)
        if (fresh()) land(next)
      }

      // Back to 'loading' on every focus rather than keeping the last
      // answer while revalidating: the previous visit's answer is a claim
      // about where the phone was THEN, and re-showing it is how a coach
      // ends up commanding the studio they left. Spec §3 State C paints a
      // skeleton for this; only the SHIFT lists paint stale-while-revalidate.
      setResult({ status: 'loading', location: null, foregroundPermission: 'unknown', hasRegions: false })

      // HOME-FAST.1 — and, in parallel, hand Home something to paint DURING
      // that loading window: the persisted verdict. Deliberately outside the
      // `!profile` gate below — the whole complaint is that auth, the region
      // fetch and the GPS acquisition serialise behind a bare spinner, and
      // this read depends on none of them. Only until the first live answer
      // lands; after that the disk copy is stale by construction.
      hydrateOnce().then((snap) => {
        if (fresh() && !resolvedRef.current) setVerdict(snap.verdict)
      })

      // Stay at 'loading' until the profile lands. auth-context seeds
      // `locations` to [] and clears its own `loading` as soon as the
      // SESSION is known — before /me returns — so resolving here on a cold
      // start would burn a full GPS acquisition to reach the one answer an
      // empty assignment list can give ('offsite', via the no-matching-id
      // branch of resolvePhysicalLocation), paint the whole offsite Home,
      // and then resolve a second time when /me lands. `profile?.id` in the
      // deps is what re-runs this once it does.
      if (!profile) return () => { active = false }

      resolve()

      // HOME-LOC.12 — spec §2 promises resolution on focus OR app foreground,
      // and focus alone is not enough: a coach can leave a control screen open,
      // drive to the other gym, and RESUME the app, at which point the screen
      // never re-focuses and the frozen green "detected" pill keeps asserting
      // the studio they left — with no recovery route on the control screens.
      // The per-visit freeze protects against GPS wobble MID-VISIT; it was
      // never meant to survive the phone having been to another gym while
      // backgrounded. Same treatment as refresh(): bump the visit (so an
      // in-flight resolve's fresh() fails and cannot land late over this one),
      // drop the position cache (a resume after time away is exactly when a
      // cached fix is suspect), and re-run the SAME resolveOnce path.
      //
      // Subscribed INSIDE the focus effect, so it exists only while this
      // screen is focused and comes off in the cleanup below — the blurred
      // screens' hooks must not all re-resolve on every foreground.
      //
      // Subscription idiom (previous-state ref + remove() on cleanup) follows
      // foreground-ota.jsx. The GATE is deliberately looser than a
      // `prev === 'background'` check: ANY non-active → 'active' counts.
      // RN's iOS willEnterForeground mapping has differed across versions —
      // 0.86 hardcodes it to "background" (real foregrounds report
      // background→active directly; verified in RCTAppState.mm), but older
      // RNs read the live applicationState there and emitted
      // background→INACTIVE→active, under which a background-only gate is
      // dead code. Gating on a state NAME ties correctness to that upstream
      // mapping; this gate does not. It can only OVER-resolve (a
      // control-centre pull-down costs one GPS read and a spinner); it cannot
      // under-resolve, and a stale green "detected" pill asserting the wrong
      // studio is far worse than a spare acquisition. LocationGate.jsx uses
      // the same `s === 'active'` shape.
      //
      // The gate discriminates on TIME AWAY, not the state name: a Control
      // Centre / notification-shade glance round-trips inactive → active in
      // seconds, and re-resolving on that would drop the position cache and
      // put the screen through 'loading' — during which the resolution falls
      // back to activeLocation, a mid-visit retarget the per-visit freeze
      // exists to prevent. Under POSITION_TTL_MS the cached fix is still
      // good and the frozen verdict still true; over it, the phone may
      // genuinely have been to the other gym.
      let prev = AppState.currentState
      let leftAt = 0
      const sub = AppState.addEventListener('change', (nextState) => {
        const wasAway = prev !== 'active'
        if (nextState !== 'active') {
          if (!wasAway) leftAt = Date.now()
          prev = nextState
          return
        }
        prev = nextState
        if (!wasAway || Date.now() - leftAt <= POSITION_TTL_MS) return
        const fgVisit = ++visitRef.current
        positionCache = { at: 0, position: null }
        setResult({ status: 'loading', location: null, foregroundPermission: 'unknown', hasRegions: false })
        // forceFresh, and not merely the dropped cache: since HOME-FAST.1 a
        // last-known fix satisfies a resolve, so dropping the 45s cache alone
        // would no longer force anything — the OS's own cached fix (possibly
        // taken at the gym we just drove away from, and inside the 5-minute
        // gate) would answer instead. "The phone may have MOVED" is exactly
        // the question only the radio can answer.
        resolveOnce(locationsRef.current, { forceFresh: true }).then((next) => {
          if (active && visitRef.current === fgVisit) land(next)
        })
      })

      return () => { active = false; sub.remove() }
    }, [locationIds, profile?.id])  // eslint-disable-line react-hooks/exhaustive-deps
  )

  // HOME-LOC.8b — an EXPLICIT re-resolve, for a pull-to-refresh. The gesture
  // means "I have moved", so it must actually re-read the radio: the
  // position cache is dropped first (dropped, not bypassed — every other
  // screen's ≤45s cached fix is equally stale once the user has told us so)
  // AND the resolve runs forceFresh, which since HOME-FAST.1 is what keeps
  // that promise — a dropped cache alone now just falls through to the OS's
  // last-known fix, which is the very answer the gesture is disputing.
  // The region cache is deliberately kept: its TTL answers "where are the
  // studios", which a refresh gesture says nothing about.
  //
  // Bumping visitRef is what makes this safe against an in-flight focus
  // resolve — that resolve's `fresh()` now fails, so an older answer landing
  // late can never overwrite this one.
  const refresh = useCallback(async () => {
    // Keyed on the id, not the object: auth-context mints a new `profile`
    // on every /me refresh, and an unstable refresh() would churn every
    // caller's onRefresh deps.
    if (!profile?.id) return
    const visit = ++visitRef.current
    positionCache = { at: 0, position: null }
    setResult({ status: 'loading', location: null, foregroundPermission: 'unknown', hasRegions: false })
    const next = await resolveOnce(locationsRef.current, { forceFresh: true })
    if (visitRef.current === visit) land(next)
    // locationsRef is read through the ref for the reason documented above.
  }, [profile?.id, land])

  // The verdict is re-aged HERE, at read time, not only when it was parsed
  // off disk: a phone left open on Home at 09:00 with a live at_studio
  // verdict must not paint that studio's tiles when it is foregrounded at
  // 13:00. Same 30-minute window either way, one definition.
  return { ...result, lastVerdict: freshVerdict(verdict, Date.now()), refresh }
}
