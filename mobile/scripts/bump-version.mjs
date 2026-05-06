#!/usr/bin/env node
// Bump the iOS app's marketing version in app.config.js.
//
// Usage:
//   node scripts/bump-version.mjs patch     # 0.1.0 -> 0.1.1
//   node scripts/bump-version.mjs minor     # 0.1.1 -> 0.2.0
//   node scripts/bump-version.mjs major     # 0.2.0 -> 1.0.0
//   node scripts/bump-version.mjs 1.4.2     # explicit value
//
// Flags:
//   --no-commit   Skip the git commit + tag (default: commit + tag)
//   --no-push     Skip the git push (default: push)
//
// What it does (in order):
//   1. Reads the existing `version: 'X.Y.Z'` line from
//      mobile/app.config.js using a strict regex.
//   2. Computes the new version (semver bump or explicit).
//   3. Writes it back, leaving everything else byte-identical.
//   4. Stages app.config.js, commits with a descriptive message,
//      tags the commit `mobile-vX.Y.Z`, and pushes both.
//
// `buildNumber` is handled by EAS Build (eas.json sets
// `appVersionSource: 'remote'`) — every native build auto-increments
// the build number. We only manage the marketing version here.

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(HERE, '..', 'app.config.js')

function readVersion() {
  const src = readFileSync(CONFIG_PATH, 'utf8')
  const m = src.match(/version:\s*'(\d+)\.(\d+)\.(\d+)'/)
  if (!m) throw new Error('Could not find a `version: \'X.Y.Z\'` line in app.config.js')
  return { src, major: +m[1], minor: +m[2], patch: +m[3] }
}

function writeVersion(src, newVersion) {
  const next = src.replace(/version:\s*'\d+\.\d+\.\d+'/, `version: '${newVersion}'`)
  if (next === src) throw new Error('Replacement made no change — check the regex.')
  writeFileSync(CONFIG_PATH, next, 'utf8')
}

function bump(kind, current) {
  const { major, minor, patch } = current
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'major') return `${major + 1}.0.0`
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind
  throw new Error(`Unknown bump kind: ${kind} (expected patch|minor|major|X.Y.Z)`)
}

function main() {
  const args = process.argv.slice(2)
  const positional = args.filter(a => !a.startsWith('--'))
  const flags = new Set(args.filter(a => a.startsWith('--')))
  const kind = positional[0]

  if (!kind) {
    console.error('Usage: node scripts/bump-version.mjs <patch|minor|major|X.Y.Z> [--no-commit] [--no-push]')
    process.exit(1)
  }

  const current = readVersion()
  const oldVersion = `${current.major}.${current.minor}.${current.patch}`
  const newVersion = bump(kind, current)

  if (oldVersion === newVersion) {
    console.error(`Version is already ${oldVersion} — nothing to do.`)
    process.exit(1)
  }

  writeVersion(current.src, newVersion)
  console.log(`✓ ${oldVersion} → ${newVersion}  (mobile/app.config.js)`)

  if (flags.has('--no-commit')) {
    console.log('  Skipped commit (--no-commit). Stage and commit manually when ready.')
    return
  }

  // The script lives inside the mobile/ tree but git operations need
  // to run from the repo root so paths resolve cleanly.
  const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
  const opts = { cwd: repoRoot, stdio: 'inherit' }

  execSync('git add mobile/app.config.js', opts)
  execSync(
    `git commit -m "Mobile: bump version ${oldVersion} -> ${newVersion}\n\nNext native release. Trigger 'Release iOS' on expo.dev when ready."`,
    opts,
  )
  execSync(`git tag -a mobile-v${newVersion} -m "Mobile iOS release ${newVersion}"`, opts)
  console.log(`✓ Committed + tagged mobile-v${newVersion}`)

  if (flags.has('--no-push')) {
    console.log('  Skipped push (--no-push). Run `git push --follow-tags` when ready.')
    return
  }

  execSync('git push --follow-tags', opts)
  console.log(`✓ Pushed to origin (with tag).`)
  console.log()
  console.log('Next: trigger "Release iOS" at expo.dev → Workflows.')
}

main()
