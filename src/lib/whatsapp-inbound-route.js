// WAORGNUMBER.5 (spec R4) — which studio an inbound WhatsApp message lands at
// when the number it was sent to is shared across an organisation.
//
// One number (N, organisation O) can be switched on at several studios
// (location_whatsapp_numbers). A member writing to N has one chat on their
// phone but up to one thread per studio in the CRM, so the webhook and the
// coexistence ingest ask this helper which thread a message belongs to:
//
//   1. candidates — the studios N is switched on at, plus N's home studio;
//   2. quoted     — the message quotes one (context.id) in a thread at a candidate;
//   3. ad         — a click-to-WhatsApp ad that belongs to a candidate studio;
//   4. recent     — the member's thread at a candidate with the latest OUTBOUND
//                   message (staff, Mia or an automation) in RECENT_OUTBOUND_MS;
//                   a tie goes to the higher thread id (Review Focus 4);
//   5. home       — the member's home studio (contacts.location_id), if a candidate;
//   6. numberless_home — TRANSITIONAL (WAHOMESTUDIO.1, deleted in WAORGNUMBER.6):
//                   a home studio of the same organisation with nothing switched
//                   on (numberlessHomeStudio), or a thread staff moved to such a
//                   studio (the webhook's old F1 rule), so Hatch Street's threads
//                   stay at Hatch until Hatch switches the number on;
//   7. number_home — N's home studio.
//
// Any failed read is logged and falls through to the next step: the webhook
// must answer Meta 200, and a message filed at the number's home studio is
// answerable where a lost one is not. Never throws.
import { logWarn } from './log'
import { studiosUsingNumbers, locationsWithWhatsApp } from './whatsapp-config'
import { numberlessHomeStudio } from './whatsapp-thread-location'
import { adSignal } from './wa-studio-pick/signals'

export const RECENT_OUTBOUND_MS = 7 * 24 * 60 * 60 * 1000

const CONVERSATION_COLUMNS = 'id, location_id, contact_id, ctwa_clid, studio_resolution, wa_phone, wa_bsuid, whatsapp_number_id'

function warn(message, meta, e) {
  logWarn('wa-inbound-route', message, { ...meta, err: e?.message || String(e) })
}

// The member's threads at `locationIds`, by phone and by BSUID (two reads, so
// neither value is ever spliced into a filter string). A failed read is [].
async function memberThreads(db, { waPhone, bsuid, locationIds }) {
  if (!locationIds.length) return []
  const found = new Map()
  for (const [col, value] of [['wa_phone', waPhone], ['wa_bsuid', bsuid]]) {
    if (!value) continue
    try {
      const { data, error } = await db.from('whatsapp_conversations')
        .select(CONVERSATION_COLUMNS)
        .eq(col, String(value))
        .in('location_id', locationIds)
        .limit(50)
      if (error) throw error
      for (const row of data || []) if (!found.has(row.id)) found.set(row.id, row)
    } catch (e) {
      warn('member thread lookup failed', { col, locationIds }, e)
    }
  }
  return [...found.values()]
}

// The member's one thread at `locationId`: by phone first (the unique key the
// webhook writes), else by BSUID. Null when none or the read fails.
async function threadAt(db, { waPhone, bsuid, locationId }, known) {
  const byPhone = known.find((t) => t.location_id === locationId && waPhone && t.wa_phone === waPhone)
  if (byPhone) return byPhone
  const byBsuid = known.find((t) => t.location_id === locationId && bsuid && t.wa_bsuid === bsuid)
  if (byBsuid) return byBsuid
  const rows = await memberThreads(db, { waPhone, bsuid, locationIds: [locationId] })
  return rows.find((t) => waPhone && t.wa_phone === waPhone) || rows[0] || null
}

async function quotedStudio(db, contextMessageId, candidates) {
  if (!contextMessageId) return null
  try {
    // Mig 723 files every message at its conversation's studio, so the
    // message's location_id is its thread's.
    const { data, error } = await db.from('whatsapp_messages')
      .select('location_id')
      .eq('wa_message_id', String(contextMessageId))
      .in('location_id', candidates)
      .limit(1)
    if (error) throw error
    return data?.[0]?.location_id || null
  } catch (e) {
    warn('quoted-message lookup failed', { contextMessageId }, e)
    return null
  }
}

async function recentThread(db, threads, now) {
  if (!threads.length) return null
  try {
    const { data, error } = await db.from('whatsapp_messages')
      .select('conversation_id, sent_at')
      .in('conversation_id', threads.map((t) => t.id))
      .eq('direction', 'outbound')
      .gte('sent_at', new Date(now - RECENT_OUTBOUND_MS).toISOString())
      .order('sent_at', { ascending: false })
      .order('conversation_id', { ascending: false })
      .limit(1)
    if (error) throw error
    const top = data?.[0]
    return top ? threads.find((t) => t.id === top.conversation_id) || null : null
  } catch (e) {
    warn('recent outbound lookup failed', { threads: threads.length }, e)
    return null
  }
}

// TRANSITIONAL (WAHOMESTUDIO.1 F1, deleted in WAORGNUMBER.6) — the one thread
// for this sender, stamped with the receiving number, at a studio of the
// organisation (never `excludeLocationId`) that has nothing switched on: staff
// moved it there (Move to studio, or the studio picker), and it keeps replying
// through this number, so the message follows it. None, several, or a failed
// read → null.
async function movedNumberlessThread(db, { waPhone, numberId, organizationId, excludeLocationId }) {
  if (!waPhone || !numberId || !organizationId) return null
  try {
    const { data: locs, error: locErr } = await db.from('locations').select('id').eq('organization_id', organizationId)
    if (locErr) throw locErr
    const orgLocIds = (locs || []).map((l) => l.id).filter((id) => id && id !== excludeLocationId)
    if (orgLocIds.length === 0) return null
    const { data: rows, error } = await db.from('whatsapp_conversations')
      .select(CONVERSATION_COLUMNS)
      .eq('wa_phone', String(waPhone))
      .eq('whatsapp_number_id', numberId)
      .in('location_id', orgLocIds)
      .limit(20)
    if (error) throw error
    if (!rows?.length) return null
    const withNumber = await locationsWithWhatsApp(db, [...new Set(rows.map((r) => r.location_id))])
    const numberless = rows.filter((r) => !withNumber.has(r.location_id))
    return numberless.length === 1 ? numberless[0] : null
  } catch (e) {
    warn('moved-thread lookup failed', { numberId }, e)
    return null
  }
}

/**
 * @returns {Promise<{ locationId: string, conversation: object|null,
 *   by: 'quoted'|'ad'|'recent'|'home'|'numberless_home'|'number_home',
 *   switchedOn: boolean }>}  `switchedOn`: the number is switched on at the
 *   winning studio (assumed for its home studio when the link read failed),
 *   i.e. whether the caller stamps it on the thread.
 */
export async function routeInboundThread(db, {
  numberId, numberHomeLocationId, organizationId, waPhone, bsuid, contact,
  contextMessageId, referral, now = Date.now(),
}) {
  let linked = null
  try {
    linked = numberId ? await studiosUsingNumbers(db, [numberId]) : []
  } catch (e) {
    warn('studios using the number unreadable; routing to its home studio', { numberId }, e)
  }
  const switchedOnSet = new Set(linked ?? [numberHomeLocationId])
  const candidates = [...new Set([...(linked || []), numberHomeLocationId].filter(Boolean))]

  let threads = []
  const ids = { waPhone, bsuid }
  const win = async (locationId, by, conversation) => ({
    locationId,
    by,
    conversation: conversation === undefined ? await threadAt(db, { ...ids, locationId }, threads) : conversation,
    switchedOn: switchedOnSet.has(locationId),
  })

  try {
    const quoted = await quotedStudio(db, contextMessageId, candidates)
    if (quoted) return await win(quoted, 'quoted')

    const fromAd = await adSignal(db, referral, candidates)
    if (fromAd) return await win(fromAd, 'ad')

    threads = await memberThreads(db, { ...ids, locationIds: candidates })
    const recent = await recentThread(db, threads, now)
    if (recent) return await win(recent.location_id, 'recent', recent)

    const home = contact?.location_id
    let result
    if (home && candidates.includes(home)) {
      result = await win(home, 'home')
    } else {
      const numberless = await numberlessHomeStudio(db, contact, numberHomeLocationId)
      result = numberless
        ? await win(numberless, 'numberless_home')
        : await win(numberHomeLocationId, 'number_home')
    }
    if (!result.conversation) {
      const moved = await movedNumberlessThread(db, { waPhone, numberId, organizationId, excludeLocationId: result.locationId })
      if (moved) return { locationId: moved.location_id, by: 'numberless_home', conversation: moved, switchedOn: switchedOnSet.has(moved.location_id) }
    }
    return result
  } catch (e) {
    warn('inbound routing failed; filing at the number’s home studio', { numberId }, e)
    return { locationId: numberHomeLocationId, by: 'number_home', conversation: null, switchedOn: switchedOnSet.has(numberHomeLocationId) }
  }
}
