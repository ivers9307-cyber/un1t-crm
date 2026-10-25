// src/lib/availability-leave.js
//
// AVAIL.3 D1 (Richard, 3 Oct 2026: "treat like leave") — the server half of
// shared/unavailable-days.js. Reads the all-day dated availability rules
// ("I can't work 11-13 Oct") for some people over a date range and returns
// them as leave-shaped rows, so every reader of approved time off can append
// them and decide with the same rule (isOffOn / offLookup).
//
// Scope is by PERSON, never studio: availability belongs to the person, like
// leave (LEAVE.2), and Richard confirmed (3 Oct) that a two-studio coach is
// unavailable at both.
//
// Service-role client passed in (mig 630's table has no browser grant).
// tests/leave-readers-availability-guard.test.js fails a reader of approved
// time off that does not import this module.

import { availabilityLeaveRows } from '@shared/unavailable-days'

const PAGE = 1000
const ID_CHUNK = 150 // keeps the .in() list well inside a URL

/**
 * All-day dated availability rules of `profileIds` overlapping
 * [startDate, endDate], as leave-shaped rows (type 'unavailable', status
 * 'approved', source 'availability', `profiles.full_name` embedded). Paged.
 * A failed read is `{ rows: null, error }`, never an empty list.
 * @returns {Promise<{ rows: object[]|null, error: object|null }>}
 */
export async function readAvailabilityLeave(db, { profileIds, startDate, endDate }) {
  const ids = [...new Set((profileIds || []).filter(Boolean))]
  if (ids.length === 0 || !startDate || !endDate) return { rows: [], error: null }
  const rules = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('staff_unavailability')
        // Literal on purpose: check:select-columns only resolves literal selects.
        .select('id, profile_id, kind, start_date, end_date, all_day, note, profiles!profile_id(full_name)')
        .in('profile_id', chunk)
        .eq('kind', 'dated')
        .eq('all_day', true)
        .lte('start_date', endDate)
        .gte('end_date', startDate)
        .order('start_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) return { rows: null, error }
      rules.push(...(data || []))
      if (!data || data.length < PAGE) break
    }
  }
  return { rows: availabilityLeaveRows(rules), error: null }
}

/**
 * `leaveRows` (approved time off the caller already read) plus the
 * availability rows for the same people and range. On a failed availability
 * read the leave rows come back unchanged WITH the error: each caller keeps
 * the failure policy it already has for a failed leave read (a copy stops, a
 * publish throws, an advisory degrades).
 */
export async function withAvailabilityLeave(db, leaveRows, { profileIds, startDate, endDate }) {
  const { rows, error } = await readAvailabilityLeave(db, { profileIds, startDate, endDate })
  if (error) return { rows: leaveRows || [], error }
  return { rows: [...(leaveRows || []), ...rows], error: null }
}
