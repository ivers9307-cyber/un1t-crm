// PIPEBUILD.5d — a small in-memory supabase double for the board builder
// tests: from(t).select/insert/update/delete with eq/in/order/range,
// maybeSingle, head counts, and the create_configured_pipeline rpc (mig 815:
// a duplicate (location_id, key) or stage (location_id, slug) is a 23505).

let seq = 0
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

export function fakeDb(seed = {}) {
  const tables = {
    locations: [], pipelines: [], pipeline_stages: [], pipeline_stage_followups: [], deals: [],
    ...Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))])),
  }
  const calls = { rpc: [], updates: [], inserts: [], deletes: [] }
  const failures = {}       // `${table}:${op}` -> error, or rpc name -> [errors…]

  function builder(table) {
    const filters = []
    let op = 'select'
    let payload = null
    let head = false
    let single = false
    let range = null
    const b = {
      select(_cols, opts = {}) { if (op === 'select') head = !!opts.head; return b },
      insert(rows) { op = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return b },
      update(patch) { op = 'update'; payload = patch; return b },
      delete() { op = 'delete'; return b },
      eq(col, v) { filters.push((r) => r[col] === v); return b },
      in(col, vs) { filters.push((r) => vs.includes(r[col])); return b },
      order() { return b },
      range(from, to) { range = [from, to]; return b },
      limit() { return b },
      maybeSingle() { single = true; return b },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject) },
    }
    function run() {
      const failure = failures[`${table}:${op}`]
      if (failure) return { data: null, error: failure }
      const rows = tables[table] || (tables[table] = [])
      const match = (r) => filters.every((f) => f(r))
      if (op === 'insert') {
        const added = payload.map((r) => ({ id: newId(), archived: false, ...r }))
        rows.push(...added)
        calls.inserts.push({ table, rows: added })
        return { data: added.map((r) => ({ id: r.id })), error: null }
      }
      if (op === 'update') {
        const hit = rows.filter(match)
        hit.forEach((r) => Object.assign(r, payload))
        calls.updates.push({ table, patch: payload, ids: hit.map((r) => r.id) })
        return { data: hit.map((r) => ({ id: r.id })), error: null }
      }
      if (op === 'delete') {
        const hit = rows.filter(match)
        tables[table] = rows.filter((r) => !match(r))
        calls.deletes.push({ table, ids: hit.map((r) => r.id) })
        return { data: hit.map((r) => ({ id: r.id })), error: null }
      }
      let out = rows.filter(match)
      if (head) return { data: null, count: out.length, error: null }
      if (range) out = out.slice(range[0], range[1] + 1)
      if (single) return { data: out[0] ? { ...out[0] } : null, error: null }
      return { data: out.map((r) => ({ ...r })), error: null }
    }
    return b
  }

  const db = {
    tables,
    calls,
    failures,
    from: (t) => builder(t),
    async rpc(name, args) {
      calls.rpc.push({ name, args })
      const queued = failures[name]
      if (Array.isArray(queued) && queued.length) return { data: null, error: queued.shift() }
      if (name !== 'create_configured_pipeline') return { data: null, error: { code: 'PGRST202', message: 'no such function' } }
      const loc = args.p_location_id
      if (tables.pipelines.some((p) => p.location_id === loc && p.key === args.p_key)) {
        return { data: null, error: { code: '23505', message: 'pipelines_location_key_unique' } }
      }
      for (const s of args.p_stages) {
        if (tables.pipeline_stages.some((r) => r.location_id === loc && r.slug === s.slug)) {
          return { data: null, error: { code: '23505', message: 'pipeline_stages_location_slug_unique' } }
        }
      }
      const id = newId()
      tables.pipelines.push({
        id, location_id: loc, key: args.p_key, name: args.p_name, module: args.p_module, mode: 'derived',
        is_primary: false, display_order: 99, enabled: false, board_type: args.p_board_type,
        recipe_key: args.p_recipe_key, config: args.p_config, priority: args.p_priority,
        created_by: args.p_created_by, baseline_at: null, updated_at: 'created',
      })
      for (const s of args.p_stages) {
        tables.pipeline_stages.push({ id: newId(), pipeline_id: id, location_id: loc, archived: false, ...s })
      }
      return { data: id, error: null }
    },
  }
  return db
}
