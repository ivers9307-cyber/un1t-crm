// HOSTPORTAL.3 — the counts behind the Overview's "Last 30 days" row.
// Read-only. Each figure is its own head:true exact count and is null when its
// own read failed, so one bad table never turns a figure into a 0 or hides the
// others. Money is not here: it is getHostRevenue with a window.

import { logWarn } from '@/lib/log'

const CHUNK = 100

// `start` returns db.from(t).select(..., head) so the head/count options sit on
// the FIRST .select() (later ones are ignored); `build` adds the filters.
async function countChunks(start, column, eventIds, build) {
  let total = 0
  for (let i = 0; i < eventIds.length; i += CHUNK) {
    const { count, error } = await build(start()).in(column, eventIds.slice(i, i + CHUNK))
    if (error) throw new Error(error.message)
    total += count || 0
  }
  return total
}

async function guarded(name, fn) {
  try {
    return await fn()
  } catch (e) {
    logWarn('host-rollup', `${name} count failed`, { err: e })
    return null
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {{ hostId:string, eventIds:string[], sinceIso:string, sinceDay:string }} p
 * @returns {Promise<{ bookings:number|null, views:number|null, signups:number|null, contacts:number|null }>}
 */
export async function loadHostRollup(db, { hostId, eventIds, sinceIso, sinceDay }) {
  const ids = eventIds || []
  const head = { count: 'exact', head: true }

  const bookings = ids.length === 0 ? 0 : await guarded('bookings', () => countChunks(
    () => db.from('race_registrations').select('id', head),
    'race_event_id', ids,
    (q) => q.eq('status', 'confirmed').gte('registered_at', sinceIso),
  ))
  const views = ids.length === 0 ? 0 : await guarded('views', () => countChunks(
    () => db.from('event_page_views').select('id', head),
    'race_event_id', ids,
    (q) => q.gte('day', sinceDay),
  ))
  const signups = await guarded('signups', async () => {
    const { count, error } = await db.from('host_contacts').select('id', head)
      .eq('host_id', hostId).eq('source', 'mailing_list').gte('created_at', sinceIso)
    if (error) throw new Error(error.message)
    return count || 0
  })
  const contacts = await guarded('contacts', async () => {
    const { count, error } = await db.from('host_contacts').select('id', head).eq('host_id', hostId)
    if (error) throw new Error(error.message)
    return count || 0
  })
  return { bookings, views, signups, contacts }
}
