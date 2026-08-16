#!/usr/bin/env node
// TENANT.8 (item 3a) — drift guard between shared/permission-bundles.js
// (KEY_BUNDLES, the source of truth) and the seed data pasted into the
// LATEST migration that reseeds `private.permission_key_bundles` (the
// SQL mirror `private.auth_mobile_can` reads at RLS-check time).
//
// The seed table can't be generated at migration-apply time (Postgres
// can't import a JS module), so scripts/generate-bundle-sql.mjs's
// output gets pasted by hand into a migration whenever KEY_BUNDLES
// changes. This script is the tripwire for "pasted it once, then kept
// editing KEY_BUNDLES without ever re-seeding" — it re-runs the
// generator fresh and diffs against whatever migration file most
// recently seeded the table, failing loudly (not silently drifting)
// the moment the two disagree.
//
// Scope, deliberately: this reads migration FILES, the same way
// check-rls-restrictive.mjs and check-location-scoping.mjs already do
// — authoritative only because migrations are forward-only and applied
// exclusively via Supabase MCP (see CLAUDE.md). A seed table hand-edited
// directly in the dashboard is invisible to it, same caveat as those
// checks.
//
// Usage:
//   npm run check:bundle-sql
//   node scripts/check-bundle-sql.mjs --json   (machine-readable)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateBundleRows } from './generate-bundle-sql.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const MIG_DIR = path.join(repoRoot, 'supabase/migrations')

const SEED_TABLE = 'private.permission_key_bundles'

function stripSql(text) {
  // Same approach as check-rls-restrictive.mjs: dollar-quoted bodies
  // can contain semicolons/comments of their own, but nothing in this
  // repo's seed migrations wraps the INSERT in one, so a wholesale
  // drop is safe.
  return text
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/**
 * Finds the migration file (by filesystem path) that most recently
 * seeds SEED_TABLE — i.e. the highest-numbered migration containing an
 * `INSERT INTO private.permission_key_bundles`. Returns null if none
 * exists yet (pre-TENANT.8 tree).
 *
 * @param {string} migDir
 * @returns {{ file: string, path: string, source: string } | null}
 */
export function findLatestSeedMigration(migDir = MIG_DIR) {
  const files = fs.readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0))

  let latest = null
  for (const file of files) {
    const full = path.join(migDir, file)
    const source = fs.readFileSync(full, 'utf8')
    if (new RegExp(`INSERT\\s+INTO\\s+${SEED_TABLE.replace('.', '\\.')}\\b`, 'i').test(stripSql(source))) {
      latest = { file, path: full, source }
    }
  }
  return latest
}

/**
 * Extracts {key, bundle} rows from a migration's seed INSERT block(s)
 * targeting SEED_TABLE. Tolerant of the exact VALUES-list formatting
 * (whitespace/newlines) — matches every `('a', 'b')` tuple following
 * any `INSERT INTO private.permission_key_bundles (...) VALUES` in the
 * file, up to its terminating `;`.
 *
 * @param {string} source  raw migration file contents
 * @returns {Array<{key: string, bundle: string}>}
 */
export function parseSeededRows(source) {
  const clean = stripSql(source)
  const insertRe = new RegExp(
    `INSERT\\s+INTO\\s+${SEED_TABLE.replace('.', '\\.')}\\s*\\([^)]*\\)\\s*VALUES\\s*([^;]*);`,
    'gi'
  )
  const tupleRe = /\(\s*'([a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'\s*\)/gi

  const rows = []
  for (const insertMatch of clean.matchAll(insertRe)) {
    const valuesBlock = insertMatch[1]
    for (const tupleMatch of valuesBlock.matchAll(tupleRe)) {
      rows.push({ key: tupleMatch[1], bundle: tupleMatch[2] })
    }
  }
  return rows
}

function rowKey(r) {
  return `${r.key} ${r.bundle}`
}

/**
 * Diffs the freshly-generated rows (from shared/permission-bundles.js)
 * against the rows a migration actually seeded. Order-independent —
 * only the SET of (key, bundle) pairs matters, since TRUNCATE+INSERT
 * seeding has no meaningful row order.
 *
 * @param {Array<{key,bundle}>} generated
 * @param {Array<{key,bundle}>} seeded
 * @returns {{ missing: Array, extra: Array, inSync: boolean }}
 *   missing = in KEY_BUNDLES but not in the seeded migration (the
 *             migration is STALE — needs a new seed migration)
 *   extra   = in the seeded migration but not in KEY_BUNDLES (the
 *             migration seeds something that no longer exists in JS)
 */
export function diffBundleRows(generated, seeded) {
  const seededSet = new Set(seeded.map(rowKey))
  const generatedSet = new Set(generated.map(rowKey))
  const missing = generated.filter((r) => !seededSet.has(rowKey(r)))
  const extra = seeded.filter((r) => !generatedSet.has(rowKey(r)))
  return { missing, extra, inSync: missing.length === 0 && extra.length === 0 }
}

// --------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const latest = findLatestSeedMigration()
  const json = process.argv.includes('--json')

  if (!latest) {
    const msg = `check-bundle-sql: no migration seeds ${SEED_TABLE} yet. ` +
      'Run `node scripts/generate-bundle-sql.mjs` and paste its output into a new migration ' +
      'that creates + seeds the table before private.auth_mobile_can can read it.'
    if (json) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2))
    } else {
      console.error(`\n\x1b[1mBundle SQL check: FAILED\x1b[0m\n  ${msg}\n`)
    }
    process.exit(1)
  }

  const generated = generateBundleRows()
  const seeded = parseSeededRows(latest.source)

  if (seeded.length === 0) {
    const msg = `check-bundle-sql: found an INSERT INTO ${SEED_TABLE} in ${latest.file} but parsed zero rows out of it — ` +
      'the parser no longer matches this migration\'s formatting. Fix the parser, don\'t silence this.'
    if (json) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2))
    } else {
      console.error(`\n\x1b[1mBundle SQL check: FAILED\x1b[0m\n  ${msg}\n`)
    }
    process.exit(1)
  }

  const { missing, extra, inSync } = diffBundleRows(generated, seeded)

  if (json) {
    console.log(JSON.stringify({ ok: inSync, latestSeedMigration: latest.file, missing, extra }, null, 2))
    process.exit(inSync ? 0 : 1)
  }

  if (inSync) {
    console.log(`\n\x1b[1mBundle SQL check: clean\x1b[0m`)
    console.log(`  ${generated.length} (key, bundle) rows match ${latest.file} exactly.\n`)
    process.exit(0)
  }

  console.error(`\n\x1b[1mBundle SQL check: DRIFT (${missing.length + extra.length} row${missing.length + extra.length === 1 ? '' : 's'})\x1b[0m`)
  console.error(`  shared/permission-bundles.js KEY_BUNDLES no longer matches the seed in ${latest.file}.`)
  if (missing.length) {
    console.error(`\n  In KEY_BUNDLES but NOT seeded (migration is stale):`)
    for (const r of missing) console.error(`    + ('${r.key}', '${r.bundle}')`)
  }
  if (extra.length) {
    console.error(`\n  Seeded but NOT in KEY_BUNDLES (stale row, key/bundle removed or renamed):`)
    for (const r of extra) console.error(`    - ('${r.key}', '${r.bundle}')`)
  }
  console.error(`\n  Fix: run \`node scripts/generate-bundle-sql.mjs\`, and paste its output into a NEW`)
  console.error(`  migration that TRUNCATEs + re-seeds ${SEED_TABLE} (migrations are forward-only —`)
  console.error(`  never hand-edit ${latest.file}).\n`)
  process.exit(1)
}
