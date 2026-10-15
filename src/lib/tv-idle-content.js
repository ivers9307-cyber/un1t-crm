// src/lib/tv-idle-content.js
//
// TVSCENE.1 — the three idle scenes' data, read only when the board has no
// open sessions. Every read FAILS TO ABSENT: a scene with no content is
// skipped by the scheduler, which is correct; a stack trace on a studio
// floor is not. Nothing here may return an aggregate COUNT — individual
// member moments only (see the spec's constraint 1). Class entries carry a
// time and a name, never capacity or a booked count.

import { timeLabelIn } from '@/lib/location-time'

/** How far back "earned this week" looks. 65 rows / 61 people at Stillorgan. */
export const EARNED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Rows the Up next scene can show at 720px without crowding. */
export const UP_NEXT_LIMIT = 6
/** Rows the Earned scene can show at 720px without crowding. */
export const EARNED_LIMIT = 5

/** First name + last initial — the board's privacy floor, as live-board.js. */
function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1][0]}.`
}

/**
 * The string an <img src> can use for an operator push (tv_content row).
 *
 *   storage -> the public tv-content bucket URL. source_ref is a bucket PATH,
 *              and a path in an <img src> is a broken image held for the whole
 *              30s dwell. Precedent: the cast route,
 *              src/app/api/public/tv/[token]/content/route.js (bucketUrl). That
 *              builder is also inlined in TemplateEditor.jsx; this is a third
 *              copy, deliberately not refactored here, so the duplication is
 *              visible. With no project URL configured there is no usable src,
 *              so the ref is dropped (null) and the label, if any, still draws.
 *   url     -> as pushed.
 *   other   -> left alone (template = a tv_templates id, generated = a key;
 *              neither is an image, and operatorImageRef ignores them).
 */
function resolveOperatorRef(sourceType, sourceRef) {
  if (sourceType === 'storage') {
    const path = typeof sourceRef === 'string' ? sourceRef.trim() : ''
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL
    if (!path || !base) return null
    return `${base}/storage/v1/object/public/tv-content/${path}`
  }
  return sourceRef ?? null
}

async function readUpNext(db, { locationId, zone, nowMs }) {
  try {
    const { data, error } = await db
      .from('class_occurrences')
      .select('name, program, starts_at')
      .eq('location_id', locationId)
      .is('cancelled_at', null)
      .gte('starts_at', new Date(nowMs).toISOString())
      .order('starts_at', { ascending: true })
      .limit(UP_NEXT_LIMIT)
    if (error) return []
    return (data || [])
      .map((o) => ({
        starts_at: o.starts_at,
        starts_at_label: timeLabelIn(o.starts_at, zone),
        class_name: o.name || null,
        program: o.program || null,
      }))
      // A class with no readable time has nothing to show under "Up next".
      .filter((o) => o.starts_at_label)
      .slice(0, UP_NEXT_LIMIT)
  } catch {
    return []
  }
}

async function readEarned(db, { locationId, nowMs }) {
  try {
    // Why a 100-row pre-limit, then the studio filter in JS: contact_achievements
    // has no location_id of its own (it reaches a studio only through
    // contacts.location_id), and a PostgREST filter on an embedded resource is a
    // documented trap in this repo's CLAUDE.md (they silently return 0, no
    // error, under count-only head:true selects). So we read the newest 100
    // achievements in the window and keep this studio's. Starving the result
    // needs 100 other-studio achievements in a week to push this studio's out,
    // and one studio holds effectively all current achievements, so it is not
    // reachable today. Revisit when a second studio earns them.
    const { data, error } = await db
      .from('contact_achievements')
      .select('earned_at, achievement_rules!rule_id(name, tier), contacts!contact_id(name, location_id, hr_leaderboard_opt_out)')
      .gte('earned_at', new Date(nowMs - EARNED_WINDOW_MS).toISOString())
      .order('earned_at', { ascending: false })
      .limit(100)
    if (error) return []
    const out = []
    for (const row of data || []) {
      const c = row?.contacts
      const r = row?.achievement_rules
      // A contact can be erased (CASCADE) or belong to another studio; a rule
      // can be deleted. Any of those is a row we drop, never a "Member" tile.
      if (!c || !r) continue
      if (c.location_id !== locationId) continue
      if (c.hr_leaderboard_opt_out) continue
      const name = shortName(c.name)
      if (!name) continue
      out.push({
        display_name: name,
        achievement: r.name,
        tier: r.tier ?? null,
        earned_at: row.earned_at,
      })
      if (out.length >= EARNED_LIMIT) break
    }
    return out
  } catch {
    return []
  }
}

async function readOperator(db, { displayId }) {
  if (!displayId) return null
  try {
    const { data, error } = await db
      .from('tv_content')
      .select('source_type, source_ref, label, template_values')
      .eq('tv_display_id', displayId)
      .maybeSingle()
    if (error || !data) return null
    return {
      source_type: data.source_type,
      source_ref: resolveOperatorRef(data.source_type, data.source_ref),
      label: data.label ?? null,
      template_values: data.template_values ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Build the idle block. Called ONLY from the no-sessions branch of
 * buildLiveBoardPayload, so a live class pays nothing for it. It never
 * rejects: each reader catches its own failure and answers "absent".
 *
 * @param {object} db  service-role Supabase client
 * @param {object} opts
 * @param {string} opts.locationId
 * @param {string|null} opts.displayId
 * @param {string} opts.zone       IANA zone of the studio
 * @param {number} opts.nowMs
 * @returns {Promise<{ up_next: Array, earned: Array, operator: object|null }>}
 */
export async function buildIdleContent(db, { locationId, displayId = null, zone, nowMs = Date.now() } = {}) {
  const [up_next, earned, operator] = await Promise.all([
    readUpNext(db, { locationId, zone, nowMs }),
    readEarned(db, { locationId, nowMs }),
    readOperator(db, { displayId }),
  ])
  return { up_next, earned, operator }
}
