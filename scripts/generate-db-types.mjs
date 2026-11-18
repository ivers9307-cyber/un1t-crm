#!/usr/bin/env node
// DBTYPES.1 — write supabase/schema/database.d.ts from the schema snapshot.
// --check fails if the file on disk is out of date instead of writing it.
import fs from 'node:fs'
import { renderDatabaseTypes } from './lib/db-types.mjs'

const OUT = 'supabase/schema/database.d.ts'
const text = renderDatabaseTypes(JSON.parse(fs.readFileSync('supabase/schema/snapshot.json', 'utf8')))
if (process.argv.includes('--check')) {
  if (!fs.existsSync(OUT) || fs.readFileSync(OUT, 'utf8') !== text) {
    console.error(`✗ ${OUT} is out of date: run npm run db:types`)
    process.exit(1)
  }
  console.log(`✓ ${OUT} matches the schema snapshot`)
} else {
  fs.writeFileSync(OUT, text)
  console.log(`✓ wrote ${OUT}`)
}
