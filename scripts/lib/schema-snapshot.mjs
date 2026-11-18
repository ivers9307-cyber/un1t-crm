// SCHEMASNAP.1 — the pure half of the schema snapshot: build the file, and
// compare it with what supabase/migrations replays to.

/** Migration number from a file name: '088b_x.sql' → 88, 'notes.sql' → null. */
export function migrationNumber(file) {
  const m = /^(\d+)[a-z]?_/.exec(file)
  return m ? Number(m[1]) : null
}

export function buildSnapshot({ columns, rest, through }) {
  if (!Number.isInteger(through) || through <= 0) throw new Error('through must be a migration number')
  const relations = {}
  for (const name of Object.keys(columns).sort()) {
    const r = columns[name]
    relations[name] = {
      kind: r.kind,
      rls: r.rls === true,
      columns: (r.columns || []).map(([col, type, nullable, hasDefault]) => [col, type, nullable === true, hasDefault === true]),
    }
  }
  return {
    format: 1,
    through_migration: through,
    latest_applied_version: String(rest.latest_applied || ''),
    relations,
    functions: rest.functions || [],
    enums: rest.enums || {},
    foreign_keys: rest.foreign_keys || [],
  }
}

/** One relation, function or key per line, so a schema change is a small diff. */
export function stringifySnapshot(s) {
  const block = (open, close, lines) => (lines.length ? `${open}\n${lines.join(',\n')}\n  ${close}` : `${open}${close}`)
  const j = (v) => JSON.stringify(v)
  const rel = Object.entries(s.relations).map(([k, v]) => `    ${j(k)}: ${j(v)}`)
  const enums = Object.entries(s.enums).map(([k, v]) => `    ${j(k)}: ${j(v)}`)
  return `{\n  "format": ${s.format},\n  "through_migration": ${s.through_migration},\n  "latest_applied_version": ${j(s.latest_applied_version)},\n`
    + `  "relations": ${block('{', '}', rel)},\n`
    + `  "functions": ${block('[', ']', s.functions.map((f) => `    ${j(f)}`))},\n`
    + `  "enums": ${block('{', '}', enums)},\n`
    + `  "foreign_keys": ${block('[', ']', s.foreign_keys.map((f) => `    ${j(f)}`))}\n}\n`
}

/**
 * Every difference between the snapshot (live) and the replay (the folder).
 * @param {object} snapshot
 * @param {{ schema: Map<string, Set<string>>, functionNames: Set<string> }} replay
 * @returns {{ key: string, side: 'live_only'|'repo_only' }[]} keys: table:x, column:x.y, function:x
 */
export function diffSnapshot(snapshot, { schema, functionNames }) {
  const out = []
  for (const [table, r] of Object.entries(snapshot.relations)) {
    const cols = schema.get(table)
    if (!cols) { out.push({ key: `table:${table}`, side: 'live_only' }); continue }
    const live = new Set(r.columns.map((c) => c[0]))
    for (const c of live) if (!cols.has(c)) out.push({ key: `column:${table}.${c}`, side: 'live_only' })
    for (const c of cols) if (!live.has(c)) out.push({ key: `column:${table}.${c}`, side: 'repo_only' })
  }
  for (const table of schema.keys()) if (!snapshot.relations[table]) out.push({ key: `table:${table}`, side: 'repo_only' })
  const liveFns = new Set(snapshot.functions.map((f) => f[0]))
  for (const f of liveFns) if (!functionNames.has(f)) out.push({ key: `function:${f}`, side: 'live_only' })
  for (const f of functionNames) if (!liveFns.has(f)) out.push({ key: `function:${f}`, side: 'repo_only' })
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

export function validateAllowlist(entries) {
  const problems = []
  entries.forEach((e, i) => {
    if (!e?.key || !['live_only', 'repo_only'].includes(e.side)) problems.push(`entry ${i}: needs key and side`)
    if (!e?.reason || String(e.reason).length < 20) problems.push(`entry ${i}: needs a real reason`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e?.expires || '')) problems.push(`entry ${i}: expires must be YYYY-MM-DD`)
  })
  return problems
}

/** Split differences into failures and accepted ones; report stale entries. */
export function classifyDrift(diffs, entries, today) {
  const id = (d) => `${d.side}|${d.key}`
  const byId = new Map(entries.map((e) => [id(e), e]))
  const seen = new Set(diffs.map(id))
  const failures = []
  const allowed = []
  const expired = []
  for (const d of diffs) {
    const e = byId.get(id(d))
    if (!e) failures.push(d)
    else if (e.expires < today) { expired.push({ ...d, entry: e }); failures.push(d) } else allowed.push({ ...d, entry: e })
  }
  return { failures, allowed, expired, stale: entries.filter((e) => !seen.has(id(e))) }
}
