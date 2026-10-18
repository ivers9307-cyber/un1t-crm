// WAORGNUMBER.2 — a small filtering fake of the supabase client for the
// /api/whatsapp/templates routes. It models just enough PostgREST for them:
//
//   from(t).select(cols) with .eq / .is / .in / .order / .range / .limit, awaited
//     → the matching rows of state[t]; a select naming `locations` embeds
//       { name } of the row's location (state.locations), as the FK embed does
//   .insert(row) → appended to state[t] with a synthetic id; .select().single()
//     after it returns the row
//   .update(patch).eq(...) → merged into the matching rows
//
// Every write is pushed onto state.writes as { table, op, row | id, patch }.
// state.faults[`${table}:${op}`] (op = select | insert | update) answers that
// operation with { data: null, error }; a function there is asked per call
// with the select string and answers an error or null. Order is ignored.
// Fictional ids only: the repo is public.

export function fakeTemplatesDb(state) {
  state.writes = state.writes || []
  let seq = 0
  return {
    from: (table) => {
      const filters = []
      let op = 'select'
      let cols = ''
      let payload = null
      let range = null
      let cap = Infinity
      const rows = () => (state[table] = state[table] || [])
      const embed = (r) => (cols.includes('locations')
        ? { ...r, locations: (() => { const l = (state.locations || []).find((x) => x.id === r.location_id); return l ? { name: l.name } : null })() }
        : r)
      const run = () => {
        const f = state.faults?.[`${table}:${op}`]
        const fault = typeof f === 'function' ? f(cols) : f
        if (fault) return { data: null, error: fault }
        if (op === 'insert') {
          const row = { id: `new-${++seq}`, ...payload }
          rows().push(row)
          state.writes.push({ table, op, row: payload })
          return { data: [row], error: null }
        }
        const matched = rows().filter((r) => filters.every((f) => f(r)))
        if (op === 'update') {
          for (const r of matched) {
            Object.assign(r, payload)
            state.writes.push({ table, op, id: r.id, patch: payload })
          }
          return { data: matched, error: null }
        }
        let out = matched.map(embed)
        if (range) out = out.slice(range[0], range[1] + 1)
        return { data: out.slice(0, cap), error: null }
      }
      const b = {
        select: (c = '') => { if (op === 'select') cols = c; return b },
        insert: (row) => { op = 'insert'; payload = row; return b },
        update: (patch) => { op = 'update'; payload = patch; return b },
        eq: (c, v) => { filters.push((r) => r[c] === v); return b },
        is: (c, v) => { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b },
        in: (c, vals) => { filters.push((r) => vals.includes(r[c])); return b },
        order: () => b,
        range: (from, to) => { range = [from, to]; return b },
        limit: (n) => { cap = n; return b },
        maybeSingle: async () => {
          const out = run()
          if (out.error) return out
          return { data: out.data[0] ?? null, error: null }
        },
        single: async () => {
          const out = run()
          if (out.error) return out
          return out.data.length === 1 ? { data: out.data[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'not one row' } }
        },
        then: (res, rej) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}
