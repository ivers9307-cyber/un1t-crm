#!/usr/bin/env node
// SCHEMASNAP.1 — write supabase/schema/snapshot.json from the two query results
// (see supabase/schema/snapshot-queries.sql).
import fs from 'node:fs'
import { buildSnapshot, stringifySnapshot } from './lib/schema-snapshot.mjs'

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null }
const [columnsFile, restFile, through] = [arg('columns'), arg('rest'), Number(arg('through'))]
if (!columnsFile || !restFile || !Number.isInteger(through)) {
  console.error('usage: node scripts/schema-snapshot-build.mjs --columns <file> --rest <file> --through <migration number>')
  process.exit(1)
}
const snapshot = buildSnapshot({
  columns: JSON.parse(fs.readFileSync(columnsFile, 'utf8')),
  rest: JSON.parse(fs.readFileSync(restFile, 'utf8')),
  through,
})
fs.writeFileSync('supabase/schema/snapshot.json', stringifySnapshot(snapshot))
console.log(`✓ wrote supabase/schema/snapshot.json: ${Object.keys(snapshot.relations).length} relations, ${snapshot.functions.length} functions, through migration ${through}`)
