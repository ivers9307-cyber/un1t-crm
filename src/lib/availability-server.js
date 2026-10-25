// src/lib/availability-server.js
//
// AVAIL.1 — the availability data layer for /api/schedule/availability (and,
// in AVAIL.2, the phone through the same route). Service-role client passed
// in: mig 630's tables have no browser grants and no RLS policy, so the ROUTE
// is the whole access boundary (CLAUDE.md, "Service-role routes get NO RLS").
//
// Every select is a literal on its from() chain so check:select-columns can
// read it.

import { z } from 'zod'
import { timeOfDay, realIsoDate } from '@/lib/schemas'
import { AVAILABILITY_WEEKDAYS, AVAILABILITY_LIMITS, normaliseRule, splitRules, ruleKey } from '@shared/availability'

export const AVAILABILITY_RANGE_MAX_DAYS = 92
const PAGE = 1000

const Time = timeOfDay.nullable().optional()
const Note = z.string().max(AVAILABILITY_LIMITS.noteChars).nullable().optional()

export const WeeklyUnavailabilitySchema = z.object({
  weekday: z.enum([...AVAILABILITY_WEEKDAYS]),
  all_day: z.boolean().default(false),
  start_time: Time,
  end_time: Time,
  note: Note,
})

export const DatedUnavailabilitySchema = z.object({
  start_date: realIsoDate,
  end_date: realIsoDate.optional(),
  all_day: z.boolean().default(false),
  start_time: Time,
  end_time: Time,
  note: Note,
})

// SHAPE only. The cross-field rules (end after start, a real range, not in
// the past) are availabilityProblems() in shared/availability.js, so the
// phone's form and this route answer in the same words. The counts are
// capped here too so a hostile body is refused before it is normalised.
export const AvailabilityPutSchema = z.object({
  weekly: z.array(WeeklyUnavailabilitySchema).max(AVAILABILITY_LIMITS.weekly).default([]),
  dated: z.array(DatedUnavailabilitySchema).max(AVAILABILITY_LIMITS.dated).default([]),
})

/** An RPC error that is the CALLER's input (400), not an outage (500). */
export function isAvailabilityInputError(error) {
  if (!error) return false
  if (['23514', '22007', '22008', '22P02', '22023'].includes(error.code)) return true
  return /^availability_/.test(String(error.message || ''))
}

/**
 * The person's weekly rules and dated rules that have not ended, as
 * { weekly, dated } in canonical form. Rules ended before today are history
 * (mig 630) and are not returned.
 */
export async function readOwnAvailability(db, profileId, todayIso) {
  const { data, error } = await db
    .from('staff_unavailability')
    .select('kind, weekday, start_date, end_date, all_day, start_time, end_time, note')
    .eq('profile_id', profileId)
    .or(`kind.eq.weekly,end_date.gte.${todayIso}`)
    .order('created_at', { ascending: true })
  if (error) return { data: null, error }
  return { data: splitRules(data || []), error: null }
}

/**
 * ruleKey()s of the person's STORED dated rules that started before today, on
 * the given start dates (the ones the body carries that start before today).
 * The route uses them to tell a rule the coach already has from a new one:
 * an ended rule sent back by a stale tab is history, a new one is refused.
 * A failed read is an error, never "none known".
 * `rules` (canonical) feed carryStartedRules: a started rule whose end moved.
 * @returns {{ keys: Set<string> | null, rules: object[] | null, error }}
 */
export async function readKnownDatedKeys(db, profileId, todayIso, startDates) {
  if (!startDates || startDates.length === 0) return { keys: new Set(), rules: [], error: null }
  const { data, error } = await db
    .from('staff_unavailability')
    .select('kind, weekday, start_date, end_date, all_day, start_time, end_time, note')
    .eq('profile_id', profileId)
    .eq('kind', 'dated')
    .lt('start_date', todayIso)
    .in('start_date', startDates)
  if (error) return { keys: null, rules: null, error }
  const rules = (data || []).map(normaliseRule)
  return { keys: new Set(rules.map(ruleKey)), rules, error: null }
}

/**
 * Replace the person's weekly + current/future dated rules (the RPC,
 * mig 630). `weekly`/`dated` are canonical (normaliseAvailability).
 * @returns {{ result: { changed, changeId, before, after } | null, error }}
 */
export async function saveOwnAvailability(db, { profileId, actorId, todayIso, weekly, dated }) {
  const { data, error } = await db.rpc('replace_staff_unavailability', {
    p_profile_id: profileId,
    p_actor_id: actorId,
    p_today: todayIso,
    p_weekly: weekly,
    p_dated: dated,
  })
  if (error) return { result: null, error }
  return {
    result: {
      changed: data?.changed === true,
      changeId: data?.change_id ?? null,
      before: Array.isArray(data?.before) ? data.before : [],
      after: Array.isArray(data?.after) ? data.after : [],
    },
    error: null,
  }
}

/**
 * Every ACTIVE member of one studio, and their rules that bear on
 * [startDate, endDate]: every weekly rule, and the dated rules overlapping
 * the range. Flat rows with profile_id and id, canonical times. The caller
 * has already checked the studio (assertLocationAccess + a manager role AT
 * it); the member read is scoped to that studio, so another organisation's
 * coach can never appear. `active IS NOT FALSE` is mig 626's staff predicate
 * (a NULL active still counts); tombstones have no profile_locations at all.
 */
export async function readStudioAvailability(db, { locationId, startDate, endDate }) {
  const { data: links, error: linkError } = await db
    .from('profile_locations')
    .select('profile_id, profiles!inner(id, active, deleted_at)')
    .eq('location_id', locationId)
  if (linkError) return { data: null, error: linkError }
  const ids = [...new Set((links || [])
    .filter((l) => l?.profile_id && l.profiles?.active !== false && !l.profiles?.deleted_at)
    .map((l) => l.profile_id))]
  if (ids.length === 0) return { data: [], error: null }

  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('staff_unavailability')
      .select('id, profile_id, kind, weekday, start_date, end_date, all_day, start_time, end_time, note')
      .in('profile_id', ids)
      .or(`kind.eq.weekly,and(start_date.lte.${endDate},end_date.gte.${startDate})`)
      .order('profile_id', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return { data: null, error }
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { data: rows.map((r) => ({ id: r.id, profile_id: r.profile_id, ...normaliseRule(r) })), error: null }
}
