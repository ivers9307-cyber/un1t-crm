// WAORGNUMBER.1 — a small fake of the supabase client for the organisation's
// WhatsApp number routes (/api/organizations/[id]/whatsapp/*). It models what
// those routes use of PostgREST:
//
//   from(t).select(cols).eq(c, v)…[.order()/.limit()] → rows (await, .single(), .maybeSingle())
//   from(t).insert(row).select().single()           → inserts, returns the row
//   from(t).update(patch).eq(c, v)…[.select().single()] → updates every match
//   from(t).delete().eq(c, v)…                       → deletes every match
//
// Since ORGCONTACTS.0 (mig 763 dropped mig 743's AFTER INSERT trigger) a number
// inserted into whatsapp_numbers gets NO link row from the database: the route
// writes the home switch-on itself (switchOnAtHome), and a test proves it did.
// Every write is recorded on state.ops as { table, op, payload, where: [[col,
// value], …] }.
//
// state = { locations, numbers, links?, ops?, faults? }; faults['<table>:<op>']
// is the { message, code } the call answers with instead of running.
// Fictional ids only: the repo is public.

let seq = 0

export function fakeOrgNumbersDb(state) {
  state.numbers ||= []
  state.locations ||= []
  state.links ||= []
  state.ops ||= []
  state.faults ||= {}
  const rowsOf = (table) => {
    if (table === 'whatsapp_numbers') return state.numbers
    if (table === 'locations') return state.locations
    if (table === 'location_whatsapp_numbers') return state.links
    throw new Error(`fakeOrgNumbersDb: unmodelled table ${table}`)
  }

  function from(table) {
    const q = { op: 'select', payload: null, where: [], not: [] }
    const matches = () => rowsOf(table).filter((r) => q.where.every(([c, v]) => r[c] === v) && q.not.every(([c, v]) => r[c] !== v))

    function run(mode) {
      const fault = state.faults[`${table}:${q.op}`]
      if (q.op !== 'select') state.ops.push({ table, op: q.op, payload: q.payload, where: q.where.map((w) => [...w]) })
      if (fault) return { data: null, error: fault }
      let out
      if (q.op === 'insert') {
        const row = { id: `n-fake-${++seq}`, created_at: '2026-10-18T00:00:00.000Z', updated_at: '2026-10-18T00:00:00.000Z', is_active: true, is_default: false, ...q.payload }
        rowsOf(table).push(row)
        out = [row]
      } else if (q.op === 'update') {
        out = matches()
        for (const r of out) Object.assign(r, q.payload)
      } else if (q.op === 'delete') {
        const gone = matches()
        const arr = rowsOf(table)
        for (const r of gone) arr.splice(arr.indexOf(r), 1)
        if (table === 'whatsapp_numbers') state.links = state.links.filter((l) => !gone.some((g) => g.id === l.whatsapp_number_id))
        out = gone
      } else {
        out = matches()
      }
      if (mode === 'single') {
        if (out.length !== 1) return { data: null, error: { message: out.length ? 'multiple rows' : 'no rows', code: 'PGRST116' } }
        return { data: out[0], error: null }
      }
      if (mode === 'maybe') {
        if (out.length > 1) return { data: null, error: { message: 'multiple rows' } }
        return { data: out[0] ?? null, error: null }
      }
      return { data: out, error: null }
    }

    const api = {
      select() { return api },
      insert(p) { q.op = 'insert'; q.payload = p; return api },
      update(p) { q.op = 'update'; q.payload = p; return api },
      delete() { q.op = 'delete'; return api },
      eq(c, v) { q.where.push([c, v]); return api },
      neq(c, v) { q.not.push([c, v]); return api },
      in() { return api },
      order() { return api },
      limit() { return api },
      single: async () => run('single'),
      maybeSingle: async () => run('maybe'),
      then(resolve, reject) { return Promise.resolve(run('list')).then(resolve, reject) },
    }
    return api
  }
  return { from }
}
