#!/usr/bin/env node
// ROLETESTS.1 — write supabase/schema/access.json (live policies, grants and the
// functions they call) from queries 3 to 5 in supabase/schema/snapshot-queries.sql.
import fs from 'node:fs'

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null }
const [p, g, f, through] = [arg('policies'), arg('grants'), arg('functions'), Number(arg('through'))]
if (!p || !g || !f || !Number.isInteger(through)) {
  console.error('usage: node scripts/schema-access-build.mjs --policies <file> --grants <file> --functions <file> --through <migration number>')
  process.exit(1)
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const [policies, grants, fns] = [read(p), read(g), read(f)]
const hayOf = (rows) => rows.map((r) => `${r[5]} ${r[6]}`).join(' ')
const keep = fns.functions.filter((x) => x[0] === 'private')
let hay = `${hayOf(policies)} ${keep.map((x) => x[3]).join(' ')}`
for (let grew = true; grew;) {
  grew = false
  for (const x of fns.functions) {
    if (x[0] === 'public' && !keep.includes(x) && new RegExp(`\\b${x[1]}\\s*\\(`).test(hay)) { keep.push(x); hay += x[3]; grew = true }
  }
}
keep.sort((a, b) => `${a[0]}.${a[1]}(${a[2]}`.localeCompare(`${b[0]}.${b[1]}(${b[2]}`))
const out = {
  format: 1, through_migration: through, latest_applied_version: fns.latest_applied,
  policies, table_grants: grants.table_grants, column_grants: grants.column_grants, functions: keep,
  mobile_permission_defaults: fns.mobile_permission_defaults, permission_key_bundles: fns.permission_key_bundles,
}
const lines = Object.entries(out).map(([k, v]) => (Array.isArray(v)
  ? `  ${JSON.stringify(k)}: [\n${v.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]`
  : `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`))
fs.writeFileSync('supabase/schema/access.json', `{\n${lines.join(',\n')}\n}\n`)
console.log(`✓ wrote supabase/schema/access.json: ${policies.length} policies, ${keep.length} functions, through migration ${through}`)
