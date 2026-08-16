#!/usr/bin/env node
// TENANT.8 (item 3a) — generates the seed INSERT block for
// `private.permission_key_bundles` straight from
// shared/permission-bundles.js's KEY_BUNDLES, so the SQL mirror of the
// bundle map can never hand-drift from the JS source of truth.
//
// Two consumers:
//   1. A human runs this, pastes the printed INSERT block into a NEW
//      migration whenever KEY_BUNDLES changes (migrations are
//      forward-only — never hand-edit an old seed migration; write a
//      new one that TRUNCATEs + reseeds the table).
//   2. scripts/check-bundle-sql.mjs re-runs the generator and diffs its
//      output against the LATEST migration that seeds the table,
//      failing CI the moment the two drift.
//
// Usage:
//   node scripts/generate-bundle-sql.mjs        → prints the INSERT block
//   node scripts/generate-bundle-sql.mjs --json  → prints [{key,bundle}]

import { KEY_BUNDLES } from '../shared/permission-bundles.js'

/**
 * Flattens KEY_BUNDLES (key -> array of owning bundles) into a stable,
 * deterministically-ordered list of {key, bundle} rows — one row per
 * (key, bundle) pair, matching the migration's PRIMARY KEY (key, bundle).
 *
 * Sorted explicitly (not "insertion order") so a future reordering of
 * KEY_BUNDLES's literal (e.g. regrouping by hub) never shows up as a
 * spurious diff in the generated SQL — only real key/bundle changes do.
 *
 * @param {Record<string, string[]>} keyBundles
 * @returns {Array<{key: string, bundle: string}>}
 */
export function generateBundleRows(keyBundles = KEY_BUNDLES) {
  const rows = []
  for (const key of Object.keys(keyBundles).sort()) {
    for (const bundle of [...keyBundles[key]].sort()) {
      rows.push({ key, bundle })
    }
  }
  return rows
}

// Postgres identifier/string-literal safe — every key/bundle in this
// repo is a lower_snake_case JS identifier-like token (see KEY_BUNDLES /
// BUNDLE_KEYS), so a straight single-quote wrap is safe. Guard anyway:
// fail loudly rather than emit SQL that could be broken out of.
const SAFE_TOKEN = /^[a-z][a-z0-9_]*$/

function sqlLiteral(token) {
  if (!SAFE_TOKEN.test(token)) {
    throw new Error(`generate-bundle-sql: refusing to emit unsafe token "${token}" as a SQL literal`)
  }
  return `'${token}'`
}

/**
 * Renders `rows` (see generateBundleRows) as a single INSERT statement
 * body, ready to paste under a migration's `TRUNCATE ...; INSERT ...`
 * seed block. No trailing semicolon-free ambiguity: the statement is
 * complete and terminated.
 *
 * @param {Array<{key: string, bundle: string}>} rows
 * @returns {string}
 */
export function generateInsertSQL(rows = generateBundleRows()) {
  if (rows.length === 0) {
    throw new Error('generate-bundle-sql: KEY_BUNDLES produced zero rows — refusing to emit an empty seed (parser/import likely broken)')
  }
  const values = rows.map((r) => `  (${sqlLiteral(r.key)}, ${sqlLiteral(r.bundle)})`).join(',\n')
  return `INSERT INTO private.permission_key_bundles (key, bundle) VALUES\n${values};`
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(generateBundleRows(), null, 2))
  } else {
    console.log(generateInsertSQL())
  }
}
