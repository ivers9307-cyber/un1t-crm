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
//                   message (staff, Mia or an automation) in RECENT_OUTBOUND_MS
//                   that Meta did not report failed (the member never got it);
//                   a tie goes to the higher thread id, so the answer is
//                   deterministic (ids are random, not time-ordered; Review Focus 4);
//   5. relationship — ORGCONTACTS.3 (spec §3.4): the candidate studio where the
//                   person has an ACTIVE contact_studios row, by latest
//                   last_seen_at; a tie goes to their primary studio when it is
//                   one of them, else the lower location_id (pickStudioByActivity).
//                   The caller passes the rows (`contactStudios`), or null when
//                   the read failed or the sender is unknown;
//   6. home       — the member's home studio (contacts.location_id, which the
//                   caller must pass), if a candidate: the explicit fallback
//                   when no relationship row is active at a candidate;
//   7. number_home — N's home studio.
//
// WAORGNUMBER.6 deleted the transitional `numberless_home` step (WAHOMESTUDIO.1):
// a studio with nothing switched on is never a candidate, so no message files
// there (it could not be answered).
//
// Any failed read is logged and falls through to the next step: the webhook
// must answer Meta 200, and a message filed at the number's home studio is
// answerable where a lost one is not. Never throws.
import { logWarn } from './log'
import { studiosUsingNumbers } from './whatsapp-config'
import { pickStudioByActivity } from './contact-studios'
import { adSignal, replySignal } from './wa-studio-pick/signals'

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

// Step 5: the candidate studio with an active relationship row, by last
// activity. Null when the rows are unknown (null) or none is active at a
// candidate, so the home rule decides. Pure.
function relationshipStudio(contactStudios, candidates, primaryLocationId) {
  if (!Array.isArray(contactStudios)) return null
  const atCandidates = contactStudios.filter((r) => r && candidates.includes(r.location_id))
  if (!atCandidates.some((r) => r.status === 'active')) return null
  return pickStudioByActivity(atCandidates, { primaryLocationId })
}

async function recentThread(db, threads, now) {
  if (!threads.length) return null
  try {
    const { data, error } = await db.from('whatsapp_messages')
      .select('conversation_id, sent_at')
      .in('conversation_id', threads.map((t) => t.id))
      .eq('direction', 'outbound')
      .neq('status', 'failed')
      .gte('sent_at', new Date(now - RECENT_OUTBOUND_MS).toISOString())
      .lte('sent_at', new Date(now).toISOString())
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

/**
 * @returns {Promise<{ locationId: string, conversation: object|null,
 *   by: 'quoted'|'ad'|'recent'|'relationship'|'home'|'number_home',
 *   switchedOn: boolean }>}  `switchedOn`: the number is switched on at the
 *   winning studio (assumed for its home studio when the link read failed),
 *   i.e. whether the caller stamps it on the thread.
 */
export async function routeInboundThread(db, {
  numberId, numberHomeLocationId, waPhone, bsuid, contact, contactStudios = null,
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
    // Mig 723 files every message at its conversation's studio, so the quoted
    // message's location_id is its thread's (replySignal; a failed read is null).
    const quoted = await replySignal(db, contextMessageId, candidates)
    if (quoted) return await win(quoted, 'quoted')

    const fromAd = await adSignal(db, referral, candidates)
    if (fromAd) return await win(fromAd, 'ad')

    threads = await memberThreads(db, { ...ids, locationIds: candidates })
    const recent = await recentThread(db, threads, now)
    if (recent) return await win(recent.location_id, 'recent', recent)

    const home = contact?.location_id || null
    const related = relationshipStudio(contactStudios, candidates, home)
    if (related) return await win(related, 'relationship')
    if (home && candidates.includes(home)) return await win(home, 'home')
    return await win(numberHomeLocationId, 'number_home')
  } catch (e) {
    warn('inbound routing failed; filing at the number’s home studio', { numberId }, e)
    return { locationId: numberHomeLocationId, by: 'number_home', conversation: null, switchedOn: switchedOnSet.has(numberHomeLocationId) }
  }
}
