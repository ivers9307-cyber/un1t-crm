// MIACLASSNOTES.1 — a class described once is known at every studio.
//
// Class descriptions reach Mia as knowledge notes, imported per studio from
// the Glofox timetable (knowledge-import.js). A studio that is not on Glofox
// gets no import: Hatch Street had one note, about the trial, so "What's
// RECLA1M?" was a hand-off while Stillorgan held the answer.
//
// The rule: a studio borrows a sibling studio's note when
//   - the note describes a class that is on THIS studio's own timetable now
//     (matched by class name, classKey), and
//   - this studio has no note of its own for that class, enabled or not (an
//     operator who wrote their own, or switched one off, meant it).
// Nothing else crosses: a sibling's offers, prices, billing or opening hours
// are not on a timetable, so they never match.
//
// The timetable is `un1t_events` (the un1t.online sync). A studio with no
// rows there borrows nothing and costs one read. Scoping: siblings are the
// active, non-host-anchor studios of the same organisation, read from this
// studio's own row.
//
// Additive and best effort: a failed read borrows nothing and never throws,
// so the studio's own notes still answer.
import { logWarn } from '@/lib/log'

const LOG_MODULE = 'mia-class-notes'
// The timetable window a class must appear in to count as "on the timetable".
const LOOK_BACK_DAYS = 7
const LOOK_AHEAD_DAYS = 21
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_TIMETABLE_ROWS = 1000
const MAX_SIBLING_NOTES = 1000

/**
 * The class name a title stands for: "RECLA1M. - CONDITIONING" and "RECLA1M"
 * are the same class, "HYROX / TRYKA" and "HYROX/TRYKA" too. Pure.
 */
export function classKey(title) {
  return String(title ?? '')
    .split(' - ')[0]
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .trim()
    .toLowerCase()
}

/**
 * The sibling notes this studio may use, as knowledge rows under the
 * timetable's own class name, in name order. Pure.
 * @param {{ ownRows?: object[], classTitles?: string[], siblingRows?: object[] }} args
 *   ownRows: every note of this studio, enabled or not
 */
export function borrowClassNotes({ ownRows = [], classTitles = [], siblingRows = [] } = {}) {
  const own = new Set((ownRows || []).map((r) => classKey(r?.title)).filter(Boolean))
  const wanted = new Map()
  for (const t of classTitles || []) {
    const key = classKey(t)
    if (key && !own.has(key) && !wanted.has(key)) wanted.set(key, String(t).replace(/\s+/g, ' ').trim())
  }
  const out = new Map()
  for (const r of siblingRows || []) {
    if (!r || r.enabled === false) continue
    const content = String(r.content ?? '').trim()
    const key = classKey(r.title)
    if (!content || !wanted.has(key) || out.has(key)) continue
    out.set(key, { category: 'general', title: wanted.get(key), content, enabled: true, sort_order: 0 })
  }
  return [...out.values()].sort((a, b) => a.title.localeCompare(b.title))
}

/**
 * The class notes this studio borrows from its sibling studios. Never throws;
 * any failed read is an empty list.
 * @param {object} db service-role client
 * @param {string} locationId the conversation's studio
 * @param {{ nowMs?: number }} [opts]
 * @returns {Promise<object[]>} knowledge rows ({ category, title, content, enabled, sort_order })
 */
export async function readSharedClassNotes(db, locationId, { nowMs = Date.now() } = {}) {
  if (!db || !locationId) return []
  try {
    const { data: classes, error: clsErr } = await db.from('un1t_events')
      .select('title')
      .eq('location_id', locationId)
      .gte('starts_at', new Date(nowMs - LOOK_BACK_DAYS * DAY_MS).toISOString())
      .lt('starts_at', new Date(nowMs + LOOK_AHEAD_DAYS * DAY_MS).toISOString())
      .order('starts_at', { ascending: true })
      .limit(MAX_TIMETABLE_ROWS)
    if (clsErr) {
      logWarn(LOG_MODULE, 'timetable unreadable; no class notes borrowed', { locationId, code: clsErr.code ?? null })
      return []
    }
    const classTitles = [...new Set((classes || []).map((c) => c?.title).filter(Boolean))]
    if (classTitles.length === 0) return []

    const { data: own, error: ownErr } = await db.from('locations').select('organization_id').eq('id', locationId).maybeSingle()
    if (ownErr || !own?.organization_id) {
      logWarn(LOG_MODULE, 'studio unreadable; no class notes borrowed', { locationId, code: ownErr?.code ?? null })
      return []
    }
    const { data: locs, error: locErr } = await db.from('locations').select('id, active, is_host_anchor')
      .eq('organization_id', own.organization_id)
    if (locErr) {
      logWarn(LOG_MODULE, 'sibling studios unreadable; no class notes borrowed', { locationId, code: locErr.code ?? null })
      return []
    }
    const siblingIds = (locs || [])
      .filter((l) => l.id !== locationId && l.active !== false && l.is_host_anchor !== true)
      .map((l) => l.id)
    if (siblingIds.length === 0) return []

    // This studio's own notes, enabled or not, and the siblings' enabled ones.
    const { data: notes, error: noteErr } = await db.from('agent_knowledge')
      .select('location_id, title, content, enabled, sort_order')
      .in('location_id', [locationId, ...siblingIds])
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true })
      .limit(MAX_SIBLING_NOTES)
    if (noteErr) {
      logWarn(LOG_MODULE, 'notes unreadable; no class notes borrowed', { locationId, code: noteErr.code ?? null })
      return []
    }
    return borrowClassNotes({
      ownRows: (notes || []).filter((n) => n.location_id === locationId),
      classTitles,
      siblingRows: (notes || []).filter((n) => n.location_id !== locationId),
    })
  } catch (err) {
    logWarn(LOG_MODULE, 'class notes read threw; none borrowed', { locationId, errClass: err?.name })
    return []
  }
}
