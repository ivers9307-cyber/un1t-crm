// SETTINGSWIPE.1 — a fake service-role client for routes that read and write
// locations.settings through mergeLocationSettings. The helper's two chains
// are fixed:
//   read   .from('locations').select(…).eq('id', id).single()   (maybeSingle too)
//   write  .from('locations').update(patch).eq('id', id).select('id').single()
// `reads` is an array consumed in order (a GET's read, then the helper's), or
// one result reused for every read. Other tables answer `tables[name]`.
// Every update is recorded in `writes`, so a test can assert "nothing written".

export function fakeLocationsDb({ reads, write = { data: { id: 'loc' }, error: null }, tables = {} } = {}) {
  const writes = []
  const queue = Array.isArray(reads) ? [...reads] : null
  const nextRead = () => (queue ? (queue.length > 1 ? queue.shift() : queue[0]) : reads)
  const chain = (result) => {
    const b = {
      select: () => b, eq: () => b, is: () => b, not: () => b, gte: () => b, order: () => b, limit: () => b,
      single: () => Promise.resolve(result()), maybeSingle: () => Promise.resolve(result()),
      then: (ok, bad) => Promise.resolve(result()).then(ok, bad),
    }
    return b
  }
  return {
    writes,
    from(table) {
      if (table !== 'locations') return chain(() => tables[table] || { data: null, error: null })
      const b = chain(nextRead)
      b.update = (patch) => {
        writes.push({ table, patch })
        return { eq: () => ({ select: () => ({ single: () => Promise.resolve(write) }) }) }
      }
      return b
    },
  }
}

export const BOOM = { message: 'canceling statement due to statement timeout', code: '57014' }
export const NO_ROW = { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' }
