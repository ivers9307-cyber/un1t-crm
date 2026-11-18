#!/usr/bin/env node
// SCHEMASNAP.1 — does supabase/migrations still describe the live database?
//
// supabase/schema/snapshot.json is the live schema, captured read-only. This
// replays the migration files up to the snapshot's through_migration and fails
// on any table, column or function present on one side only. A change made by
// hand on the database, or a migration file that never ran, shows up here.
//
// Migrations newer than the snapshot are reported, not failed: a migration is
// written before it is applied, and only an applied one can be captured.
// Accepted differences live in .schema-snapshot-allowlist.json with a reason
// and an expiry; an expired entry fails like an unlisted difference.
import fs from 'node:fs'
import path from 'node:path'
import { applyMigrationSql } from './check-select-columns.mjs'
import { applyFunctionDdl } from './check-rpc-names.mjs'
import { migrationNumber, diffSnapshot, validateAllowlist, classifyDrift } from './lib/schema-snapshot.mjs'

const DIR = 'supabase/migrations'
const snapshot = JSON.parse(fs.readFileSync('supabase/schema/snapshot.json', 'utf8'))
const entries = JSON.parse(fs.readFileSync('.schema-snapshot-allowlist.json', 'utf8')).entries || []
const problems = validateAllowlist(entries)
if (problems.length) {
  console.error('✗ .schema-snapshot-allowlist.json is malformed:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

const schema = new Map()
const functions = new Map()
const skippedViews = new Set()
const fks = new Map()
let newer = 0
for (const f of fs.readdirSync(DIR).sort()) {
  if (!f.endsWith('.sql')) continue
  const n = migrationNumber(f)
  if (n !== null && n > snapshot.through_migration) { newer++; continue }
  const sql = fs.readFileSync(path.join(DIR, f), 'utf8')
  applyMigrationSql(sql, schema, skippedViews, fks)
  applyFunctionDdl(sql, functions, [])
}
const functionNames = new Set([...functions.keys()].filter((k) => k.startsWith('public.')).map((k) => k.slice('public.'.length)))
const diffs = diffSnapshot(snapshot, { schema, functionNames })
const { failures, allowed, expired, stale } = classifyDrift(diffs, entries, new Date().toISOString().slice(0, 10))

for (const s of stale) console.log(`  ⚠ stale allowlist entry (no longer differs): ${s.side} ${s.key}`)
if (newer) console.log(`  ⚠ ${newer} migration file(s) newer than the snapshot (through ${snapshot.through_migration}): refresh it once they are applied`)
if (failures.length === 0) {
  console.log(`✓ schema snapshot: ${Object.keys(snapshot.relations).length} relations and ${snapshot.functions.length} functions match the migrations through ${snapshot.through_migration}, ${allowed.length} known difference(s) allowlisted`)
  process.exit(0)
}
console.error(`✗ schema snapshot: ${failures.length} difference(s) between supabase/migrations and the live schema:`)
for (const d of failures) console.error(`  ${d.side === 'live_only' ? 'only on the live database' : 'only in the migration files'}: ${d.key}${expired.some((e) => e.key === d.key) ? ' (allowlist entry expired)' : ''}`)
console.error('\n  Add a forward migration, refresh the snapshot, or record the difference in .schema-snapshot-allowlist.json with a reason and an expiry.')
process.exit(1)
