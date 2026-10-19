// MIAHATCH.2 Task 8 — which tool block and prompt a turn gets, from the
// studios this person may be answered for, and which studio each executor
// runs at.
//
// auto-reply.js resolves the person's studios (member-studios.js) and asks
// planTurnTools for the turn's plan. When the plan is today's block for the
// thread (a Glofox studio answering its own member, a no-booking studio with
// nobody answerable, Instagram, a failed or absent resolution) the runner sends
// exactly today's request and leaves toolCtx.turn unset. Otherwise:
//
//   un1t_read / un1t_read_dual  the un1t.online read block (tool-blocks.js),
//                               the un1t prompt variant naming that studio,
//                               a facts block per answerable studio that is not
//                               the thread's.
//   un1t_full                   MIAHATCH.5, block 3b: the same, plus booking,
//                               cancelling and refund requests at the
//                               un1t.online studio. Only on WhatsApp, and only
//                               when every answerable un1t.online studio has
//                               writes_enabled AND its Mia switch
//                               un1t_chat_actions_enabled (Ruling 25,
//                               resolveTurnPlan); anything unreadable is the
//                               read block.
//   glofox on a non-Glofox      a member at the Glofox studio talking on a
//   thread                      thread filed at another studio: the Glofox
//                               block and render, and the Glofox executors run
//                               at the Glofox studio (its credentials, its
//                               booking mode, its contact as the anchor), never
//                               the thread's.
//
// The provider capability `bookings` never decides the block for a
// un1t.online thread (threadTakesBookings): a Hatch turn never reaches a
// Glofox executor, whatever that flag says.
import { answerableStudios } from './member-studios'
import { selectToolBlock } from './tool-blocks'
import { BOOKING_SYSTEM_TOOL_NAMES, providerTakesBookings } from './tool-capability'
import { parseAgentId } from './studio-ids'
import { buildStudioFactsBlock } from './prompt'
import { resolveAgentSettings } from './settings-resolve'
import { providerFor } from '@/lib/membership/source'
import { un1tWriteSettingsFrom } from '@/lib/un1t-online-settings'
import { zoneOfLocation } from '@/lib/location-time'
import { logWarn } from '@/lib/log'

const LOG_MODULE = 'mia-un1t'

/**
 * Does the thread's studio take bookings through Mia's Glofox tools? Today's
 * rule (the provider's `bookings` capability), except that un1t.online never
 * does: its reads and writes have their own blocks. Pure.
 */
export function threadTakesBookings(provider) {
  return provider?.key !== 'un1t_online' && providerTakesBookings(provider)
}

/**
 * The turn's plan. Pure.
 *
 * `un1tWrites` is the caller's decision (resolveTurnPlan); absent or anything
 * but true plans the read blocks, as before MIAHATCH.5.
 *
 * @param {{ memberStudios?: { studios: object[], readFailed: boolean }, threadLocationId: string,
 *   threadProvider?: { key: string, capabilities?: object }, channel: string, un1tWrites?: boolean }} args
 * @returns {{ block: string, todayBlock: string, sameAsToday: boolean, answerable: object[],
 *   un1tStudio: object|null, glofoxStudio: object|null, glofoxLocationId: string, otherStudios: object[],
 *   multiStudio: boolean, un1tWrites: boolean }}
 */
export function planTurnTools({ memberStudios, threadLocationId, threadProvider, channel, un1tWrites = false } = {}) {
  const canBook = threadTakesBookings(threadProvider)
  const todayBlock = canBook ? 'glofox' : 'no_booking'
  const studios = memberStudios && !memberStudios.readFailed && Array.isArray(memberStudios.studios)
    ? memberStudios.studios
    : null
  const answerable = studios ? answerableStudios(studios, threadLocationId).answerable : []
  // Ruling 14: a Glofox thread studio where this sender has a LIVE
  // relationship that is not "active" (ClassPass pay-as-you-go, or a member
  // paused, locked or starting later) keeps its Glofox answers when another
  // studio is answerable too: it joins the answerable set here (the dual
  // block), without changing answerableStudios' own contract (member-studios.js).
  if (studios && threadProvider?.key === 'glofox' && !answerable.some((s) => s?.locationId === threadLocationId)) {
    const thread = studios.find((s) => s?.locationId === threadLocationId && s.providerKey === 'glofox' && s.answerable === true && s.liveRelationship === true)
    if (thread) answerable.unshift(thread)
  }
  const block = selectToolBlock({
    answerable,
    // The capability as this turn reads it (un1t.online never books here).
    threadProvider: { capabilities: { bookings: canBook } },
    channel,
    un1tWrites: un1tWrites === true,
  })
  const un1tStudio = block.startsWith('un1t_') ? answerable.find((s) => s?.providerKey === 'un1t_online') || null : null
  // The Glofox studio the Glofox executors run at when the thread is not one.
  const glofoxStudio = threadProvider?.key !== 'glofox' && (block === 'glofox' || block.startsWith('un1t_'))
    ? answerable.find((s) => s?.providerKey === 'glofox') || null
    : null
  return {
    block,
    todayBlock,
    sameAsToday: block === todayBlock,
    answerable,
    un1tStudio,
    glofoxStudio,
    glofoxLocationId: glofoxStudio?.locationId || threadLocationId,
    otherStudios: answerable.filter((s) => s?.locationId !== threadLocationId),
    // A un1t block where a Glofox studio is answerable too: the prompt says
    // which studio each answer is for (always so for un1t_read_dual).
    multiStudio: block === 'un1t_read_dual' || (block === 'un1t_full' && answerable.some((s) => s?.providerKey === 'glofox')),
    un1tWrites: block === 'un1t_full',
  }
}

/** Today's plan for the thread: no studio answerable, today's block. Pure. */
export function todayPlan({ threadLocationId, threadProvider, channel } = {}) {
  return planTurnTools({ memberStudios: undefined, threadLocationId, threadProvider, channel })
}

/**
 * What the turn's system blocks depend on beyond today's options: the block,
 * the un1t.online studio the prompt names, and the studios with a facts block.
 * Two plans with the same key render the same prompt. Pure.
 */
export function planKey(plan) {
  if (!plan) return ''
  const others = (plan.otherStudios || []).map((s) => s?.locationId).filter(Boolean).sort()
  return [plan.block, plan.multiStudio === true ? 'multi' : '', plan.un1tStudio?.locationId || '', others.join(',')].join('|')
}

/**
 * Ruling 25 — may this un1t.online studio's member book, cancel and ask for a
 * refund in chat? Its Mia switch (`un1t_chat_actions_enabled`, studio-only,
 * default false) AND its `locations.settings.un1t_online.writes_enabled`.
 * The switch is read first, so with it off (the default) nothing new is read
 * and the turn is exactly what it was. Anything unreadable is false (the read
 * block), logged.
 */
async function un1tChatActionsOn(studio, studios) {
  const locationId = studio?.locationId
  try {
    const settings = await studios.settings(locationId)
    if (!settings) {
      logWarn(LOG_MODULE, 'un1t studio Mia settings unreadable; turn keeps the read block', { locationId })
      return false
    }
    if (settings.un1t_chat_actions_enabled !== true) return false
    const write = await studios.un1tWriteSettings(locationId)
    return write?.writesEnabled === true
  } catch (err) {
    logWarn(LOG_MODULE, 'un1t write settings unreadable; turn keeps the read block', { locationId, errClass: err?.name, code: err?.code ?? null })
    return false
  }
}

/**
 * The plan, with the Glofox override only where the Glofox studio's own
 * settings resolve (Ruling 15): its booking_mode and copy are never borrowed
 * from the thread's studio, so an unreadable Glofox studio means today's
 * block for the thread instead.
 */
export async function resolveTurnPlan(args, studios) {
  let plan = planTurnTools({ ...args, un1tWrites: false })
  // MIAHATCH.5 (Ruling 25) — block 3b: WhatsApp only (R3), and every
  // answerable un1t.online studio must allow it (a write runs at the studio
  // its tagged id names, so one studio's switch never opens another's).
  if (plan.un1tStudio && args?.channel === 'whatsapp') {
    const un1tStudios = plan.answerable.filter((s) => s?.providerKey === 'un1t_online')
    let allowed = un1tStudios.length > 0
    for (const studio of un1tStudios) {
      if (!(await un1tChatActionsOn(studio, studios))) { allowed = false; break }
    }
    if (allowed) plan = planTurnTools({ ...args, un1tWrites: true })
  }
  if (plan.glofoxStudio) {
    const settings = await studios.settings(plan.glofoxStudio.locationId)
    if (!settings) {
      logWarn(LOG_MODULE, 'glofox studio settings unreadable; turn keeps the thread block', { locationId: plan.glofoxStudio.locationId, block: plan.block })
      return todayPlan(args)
    }
  }
  return plan
}

/**
 * `toolCtx.turn` for a plan: undefined when the plan is today's block (the
 * executors then keep today's canBook rule exactly), else the block, the
 * answerable studios, the channel and `un1tWrites` (true only for un1t_full,
 * which resolveTurnPlan plans only when Ruling 25's conditions hold). Pure.
 */
export function turnForPlan(plan, channel) {
  if (!plan || plan.sameAsToday) return undefined
  return { block: plan.block, answerable: plan.answerable, channel, un1tWrites: plan.block === 'un1t_full' }
}

/**
 * Per-turn access to another studio's resolved Mia settings (booking_mode,
 * booking_url, copy) and its clock. The thread's own studio answers from what
 * the turn already holds; any other is resolved once (sharing one org cache)
 * and remembered for the turn. A failed resolve is null settings and the
 * thread's zone: the caller falls back, never guesses another studio's values.
 */
export function createActionStudios(db, { threadLocationId, threadSettings, threadZone, threadLocationSettings }) {
  const orgCache = new Map()
  const cache = new Map()
  const resolve = (locationId) => {
    if (!cache.has(locationId)) {
      cache.set(locationId, resolveAgentSettings(db, locationId, { orgCache }).catch((err) => {
        logWarn(LOG_MODULE, 'studio settings resolve threw', { locationId, errClass: err?.name })
        return { ok: false }
      }))
    }
    return cache.get(locationId)
  }
  return {
    /** That studio's resolved settings, or null. */
    async settings(locationId) {
      if (!locationId) return null
      if (locationId === threadLocationId) return threadSettings || null
      const r = await resolve(locationId)
      return r?.ok ? r.settings : null
    },
    /**
     * MIAHATCH.5 — that studio's un1t.online write settings
     * (un1tWriteSettingsFrom), from the locations.settings blob this turn
     * already read: the thread's own row, or the row its settings resolve read.
     * Throws when there is no blob to read (a failed resolve): the caller
     * fails closed.
     */
    async un1tWriteSettings(locationId) {
      if (!locationId) throw new Error('un1t write settings need a location id')
      if (locationId === threadLocationId) {
        if (threadLocationSettings === undefined) throw new Error('thread location settings not held')
        return un1tWriteSettingsFrom(threadLocationSettings)
      }
      const r = await resolve(locationId)
      if (!r?.ok) throw new Error('studio settings resolve failed')
      return un1tWriteSettingsFrom(r.location?.settings)
    },
    /** That studio's zone (the thread's when it cannot be read). */
    async zone(locationId) {
      if (!locationId || locationId === threadLocationId) return threadZone
      const r = await resolve(locationId)
      return r?.ok ? zoneOfLocation({ id: locationId, timezone: r.location?.timezone }) : threadZone
    },
  }
}

/**
 * The studio's enabled knowledge rows, in the order the prompt shows them:
 * the same read the turn makes for its own studio. Returns the query result
 * as is (`{ data, error }`); the caller decides what an error means.
 */
export async function loadAgentKnowledge(db, locationId) {
  return db.from('agent_knowledge')
    .select('category, title, content, enabled, sort_order')
    .eq('location_id', locationId)
    .eq('enabled', true)
    .order('sort_order', { ascending: true })
}

async function readAddress(db, locationId) {
  try {
    const { data, error } = await db.from('locations').select('address').eq('id', locationId).maybeSingle()
    if (error) {
      logWarn(LOG_MODULE, 'studio address unreadable; facts block without it', { locationId, code: error?.code ?? null })
      return null
    }
    return data?.address || null
  } catch (err) {
    logWarn(LOG_MODULE, 'studio address read threw; facts block without it', { locationId, errClass: err?.name })
    return null
  }
}

async function readKnowledge(db, locationId) {
  try {
    const { data, error } = await loadAgentKnowledge(db, locationId)
    if (error) {
      logWarn(LOG_MODULE, 'studio knowledge unreadable; facts block without it', { locationId, code: error?.code ?? null })
      return []
    }
    return Array.isArray(data) ? data : []
  } catch (err) {
    logWarn(LOG_MODULE, 'studio knowledge read threw; facts block without it', { locationId, errClass: err?.name })
    return []
  }
}

// MIAHATCH.6 — the offer titles and price labels for a un1t.online studio's
// facts block, in block 3b only (where Mia can sell them). The list module is
// loaded lazily: it sits next to the write side, which no other turn imports.
// An unreadable list is a block without offers.
async function readOffers(db, studio, withOffers) {
  if (!withOffers || studio?.providerKey !== 'un1t_online') return []
  try {
    const { listPurchaseOptions } = await import('./purchase-intents')
    const { offers } = await listPurchaseOptions(db, studio.locationId)
    return offers.map((o) => ({ title: o.title, price_label: o.price_label, blurb: o.blurb }))
  } catch (err) {
    logWarn(LOG_MODULE, 'studio offers unreadable; facts block without them', { locationId: studio.locationId, errClass: err?.name })
    return []
  }
}

/** One facts block for an answerable studio that is not the thread's. Never throws. */
async function factsBlockFor(db, studio, studios, { withOffers = false } = {}) {
  const [settings, address, knowledge, offers] = await Promise.all([
    studios.settings(studio.locationId),
    readAddress(db, studio.locationId),
    readKnowledge(db, studio.locationId),
    readOffers(db, studio, withOffers),
  ])
  return buildStudioFactsBlock({
    studioName: studio.name,
    address,
    bookingUrl: settings?.booking_url || null,
    membershipUrl: settings?.membership_signup_url || null,
    offers,
    knowledge,
  })
}

const sourceView = (key) => {
  const p = providerFor(key)
  return { key: p.key, label: p.label }
}

/**
 * The buildCachedSystem options a plan adds to today's. Call only when the
 * plan is NOT today's block (today's request is built from today's options
 * alone). The un1t variant names the un1t.online studio and carries ITS
 * booking link; the Glofox override renders the Glofox prompt. Both carry a
 * facts block per answerable studio that is not the thread's.
 */
export async function promptOptionsForPlan(db, plan, studios) {
  const factsBlocks = []
  const withOffers = plan.block === 'un1t_full'
  for (const studio of plan.otherStudios) factsBlocks.push(await factsBlockFor(db, studio, studios, { withOffers }))
  if (plan.block.startsWith('un1t_') && plan.un1tStudio) {
    const settings = await studios.settings(plan.un1tStudio.locationId)
    return {
      membershipSource: sourceView('un1t_online'),
      un1tVariant: plan.block === 'un1t_full' ? 'full' : 'read',
      multiStudio: plan.multiStudio === true,
      un1tStudioName: plan.un1tStudio.name,
      bookingUrl: settings?.booking_url || null,
      factsBlocks,
    }
  }
  if (plan.block === 'glofox') {
    return { membershipSource: sourceView('glofox'), bookings: true, bookingUrl: null, factsBlocks }
  }
  return { factsBlocks }
}

// In the Glofox block, the tools whose executors read or write Glofox (or a
// Glofox-synced contact), plus the pause request, which is filed at the
// member's studio. The timetable reads Glofox there too.
const GLOFOX_STUDIO_TOOLS = new Set([...BOOKING_SYSTEM_TOOL_NAMES, 'list_upcoming_classes', 'request_pause'])
const MEMBERSHIP_REQUEST_TOOLS = new Set(['request_pause', 'request_cancellation'])
const BOOKING_ID_FIELD = Object.freeze({ book_class: 'event_id', cancel_class_booking: 'booking_id' })

async function glofoxStudioCtx(toolCtx, studios) {
  const glofoxLocationId = toolCtx.glofoxLocationId
  if (!glofoxLocationId || glofoxLocationId === toolCtx.locationId) return toolCtx
  const studio = (toolCtx.turn?.answerable || []).find((s) => s?.locationId === glofoxLocationId)
  const ids = Array.isArray(studio?.contactIds) ? studio.contactIds : []
  // The thread's contact is often the OTHER studio's row, with no Glofox
  // account: act as the person's contact at the Glofox studio (same person
  // group, which is what made them answerable there). Unverified stays
  // unverified.
  const verified = toolCtx.verifiedContactId
  const anchor = verified && ids.length && !ids.includes(verified) ? ids[0] : verified
  const [settings, zone] = await Promise.all([studios.settings(glofoxLocationId), studios.zone(glofoxLocationId)])
  // Ruling 15: never the thread's settings for the Glofox studio. resolveTurnPlan
  // only plans an override whose settings resolved (and they are cached for the
  // turn), so this is a belt: null tells the caller to refuse the tool rather
  // than run it with another studio's settings or at the thread's studio.
  if (!settings) return null
  return {
    ...toolCtx,
    locationId: glofoxLocationId,
    verifiedContactId: anchor,
    canBook: true,
    membershipSourceKey: 'glofox',
    settings,
    zone: zone || toolCtx.zone,
  }
}

/**
 * The context one tool runs with, or null when it must not run at all (the
 * Glofox studio's settings are unreadable, or a Glofox booking id on a un1t
 * turn with no Glofox studio answerable; the caller refuses the tool).
 * Today's turn (no `toolCtx.turn`) and every
 * tool that needs nothing else get `toolCtx` itself. Otherwise:
 *   - glofox block on a non-Glofox thread: the Glofox tools run at the Glofox
 *     studio (glofoxStudioCtx);
 *   - a un1t block: book_class / cancel_class_booking with a Glofox id run at
 *     the Glofox studio, and request_pause / request_cancellation are filed at
 *     the answerable un1t.online studio (the member's), not the thread's; in
 *     the dual block their details also carry `member_studios_dual: true` and
 *     `also_member_at_location_id` (ctx.membershipRequestDetails).
 */
export async function executorCtxFor(toolName, input, toolCtx, studios) {
  const turn = toolCtx?.turn
  if (!turn) return toolCtx
  if (turn.block.startsWith('un1t_')) {
    if (MEMBERSHIP_REQUEST_TOOLS.has(toolName)) {
      const un1t = (turn.answerable || []).find((s) => s?.providerKey === 'un1t_online')
      if (!un1t) return toolCtx
      // Ruling 13: in the dual block the request is still filed at the
      // un1t.online studio (it can never auto-execute there), and the row says
      // the person is a member at the other studio too, so staff confirm which
      // membership is meant.
      // MIAHATCH.5: block 3b with a Glofox studio answerable is dual too.
      const other = turn.block === 'un1t_read_dual'
        ? (turn.answerable || []).find((s) => s && s.locationId !== un1t.locationId)
        : turn.block === 'un1t_full'
          ? (turn.answerable || []).find((s) => s?.providerKey === 'glofox')
          : null
      const extra = other
        ? { membershipRequestDetails: { member_studios_dual: true, also_member_at_location_id: other.locationId } }
        : {}
      if (un1t.locationId === toolCtx.locationId && !other) return toolCtx
      return { ...toolCtx, locationId: un1t.locationId, ...extra }
    }
    const field = BOOKING_ID_FIELD[toolName]
    if (field && parseAgentId(input?.[field])?.provider === 'glofox') {
      // MIAHATCH.5 — block 3b can be planned with no Glofox studio answerable
      // (a Hatch-only member): a Glofox id then has no studio to run at, so
      // the tool is refused rather than run at the un1t.online thread.
      if (!(turn.answerable || []).some((s) => s?.providerKey === 'glofox')) return null
      return glofoxStudioCtx(toolCtx, studios)
    }
    return toolCtx
  }
  if (turn.block === 'glofox' && GLOFOX_STUDIO_TOOLS.has(toolName)) return glofoxStudioCtx(toolCtx, studios)
  return toolCtx
}
