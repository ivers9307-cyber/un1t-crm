#!/usr/bin/env node
// OTA-VISIBLE.1 — the CLI behind the "OTA fleet" pull-request check.
//
// The verdict lives in scripts/lib/ota-fleet-state.mjs, which is pure and
// tested; this file is only the seam to `gh` and to the Actions job summary.
// Read that module's header for WHY a PR check is the right surface — the
// short version is that the two alarms this workflow already had (a red run on
// main, an auto-opened issue) both fired correctly on 2026-09-10 and were both
// unread, while main sat ahead of the phone fleet for hours.
//
//   node scripts/check-ota-fleet.mjs
//
// Exit 1 when the fleet is behind, 0 otherwise. 🔴 The check is ADVISORY — it
// must never be added to branch protection. See the module header.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync } from 'node:fs'
import { fleetState, fleetMessage } from './lib/ota-fleet-state.mjs'

const run = promisify(execFile)

const REPO = process.env.GITHUB_REPOSITORY || ''
const REPO_URL = REPO ? `https://github.com/${REPO}` : ''

/**
 * The last few EAS Update runs on main, newest first.
 *
 * Returns null — not [] — when the call fails, because those are different
 * facts and fleetState() treats them differently: [] means "nothing to judge",
 * null means "could not read", and only the second must never be reported as
 * healthy on the strength of a blip.
 */
async function fetchRuns() {
  try {
    const { stdout } = await run('gh', [
      'run', 'list',
      '--branch', 'main',
      '--workflow', 'EAS Update',
      '--limit', '10',
      '--json', 'status,conclusion,databaseId,headSha,createdAt',
    ], { timeout: 60_000 })
    const parsed = JSON.parse(stdout)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const state = fleetState(await fetchRuns())
const message = fleetMessage(state, REPO_URL)
console.log(message)

// The job summary, because a `::warning::` in a step log is precisely the
// signal OTAPREFLIGHT.2 already proved nobody reads. The red X in the PR's
// checks list is the actual notification; this is what it explains when
// somebody clicks it.
if (process.env.GITHUB_STEP_SUMMARY) {
  const heading = state.behind
    ? '## 🔴 OTA fleet is behind `main`\n\n'
    : '## ✅ OTA fleet is up to date\n\n'
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${heading}${message}\n`)
  } catch {
    // A summary we cannot write is not a reason to change the verdict.
  }
}

process.exitCode = state.behind ? 1 : 0
