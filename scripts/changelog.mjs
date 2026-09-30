#!/usr/bin/env node
// CHANGELOG-FILES.1: print the full changelog. New entries live one file per PR
// in docs/changelog/entries/<PR>.md (newest first by PR number); the historical
// table in docs/CHANGELOG.md follows unchanged.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ENTRIES_DIR = 'docs/changelog/entries'
const LEGACY = 'docs/CHANGELOG.md'

export function readEntries(dir = ENTRIES_DIR) {
  return readdirSync(dir)
    .filter((f) => /^\d+\.md$/.test(f))
    .map((f) => ({ pr: Number(f.slice(0, -3)), row: readFileSync(join(dir, f), 'utf8').trim() }))
    .sort((a, b) => b.pr - a.pr)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e })
  const rows = readEntries().map((e) => e.row)
  process.stdout.write('# Changelog (entries from docs/changelog/entries, newest first)\n\n')
  process.stdout.write('| # / PR | Item | Notes |\n|---|------|-------|\n')
  process.stdout.write(rows.join('\n') + (rows.length ? '\n' : ''))
  process.stdout.write('\n---\n\n')
  process.stdout.write(readFileSync(LEGACY, 'utf8'))
}
