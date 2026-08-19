#!/usr/bin/env node
// OTA-PATHS.1 — the tripwire that keeps .github/workflows/eas-update.yml's
// trigger an ALLOWLIST instead of drifting back into a denylist.
//
// eas-update.yml publishes a real OTA to production phones on every
// qualifying push to main. Its trigger used to be `mobile/**` with `!`
// negations bolted on as each new non-bundle file type was discovered,
// which failed twice in eight days (a docs-only push and a
// dependency-allowlist-only push each published a no-op update group at
// 10% on top of a live ramp). It is now a positive allowlist of the paths
// that genuinely enter the Metro bundle — so a new non-bundle file is
// inert by default.
//
// The cost of an allowlist is the opposite failure: a genuinely-bundled
// path nobody remembered to list means a real fix silently never reaches
// devices. THAT is what this script removes. It asserts that every
// top-level entry under mobile/ is classified as exactly one of:
//   - covered by the workflow trigger (it enters the bundle), or
//   - listed in NON_BUNDLE below, with a reason (it does not).
// A new top-level entry that is neither fails CI on the PR that creates
// it, while the author still has the context to classify it correctly.
//
// Scope, deliberately: classification is at TOP-LEVEL-ENTRY granularity
// (mobile/app, mobile/eas.json, …), not per file. Every path under mobile/
// sits beneath exactly one top-level entry, so the classification COVERS
// the tree — but read that as coverage, not as a safety guarantee. Three
// gaps follow from the granularity, and all three are known:
//
//   1. NON_BUNDLE is a per-directory ASSERTION, frozen at the moment it was
//      written, and nothing here rechecks it. `scripts` says "not imported
//      by the app" because that was verified true on 2026-08-19 (every
//      relative import/require/dynamic-import specifier under mobile/app,
//      mobile/lib, mobile/components and mobile/index.js was resolved
//      against the allowlist; the only apparent hit, mobile/lib/colors.js,
//      was inside a comment). If someone later adds mobile/scripts/foo.js
//      and imports it from mobile/lib/*, Metro bundles it, this check still
//      reports "clean" (the entry is already classified), and the push
//      silently publishes nothing. FOLLOW-UP: an import-graph reachability
//      assertion would close this; it is not built yet.
//   2. A per-FILE over-trigger inside a bundle entry is invisible here.
//      `mobile/lib/**` is listed, so all 36 `*.test.js` files under it
//      publish; `shared/**` is wholesale, so its 62 test/fixture files
//      publish too. Both are accepted over-triggers, pinned in
//      tests/ota-trigger-paths.test.js so they are visible rather than
//      forgotten. GitHub's paths filter has no exclusion form other than
//      `!`, which is the denylist this replaced — so narrowing them is not
//      a free move.
//   3. The tree-walk below covers mobile/ ONLY. shared/ is wholesale by
//      design, so nothing under it can be UNDER-published and there is
//      nothing to classify — but that also means a new shared/docs/ or
//      shared/README.md publishes an OTA and this check still says clean.
//
// Metro's true transitive closure from index.js cannot be expressed in a
// static YAML paths filter anyway.
//
// This does NOT talk to GitHub. It reproduces the documented filter
// semantics locally:
//   - "If at least one path matches a pattern in the `paths` filter, the
//      workflow runs."
//   - "The order that you define `paths` patterns matters. A matching
//      negative pattern (prefixed with !) after a positive match will
//      exclude the path. A matching positive pattern after a negative
//      match will include the path again."
// (Both quoted from GitHub's workflow-syntax reference.) The matcher is
// calibrated against two REAL observed runs in
// tests/ota-trigger-paths.test.js — one that fired and one that didn't.
//
// Usage:
//   npm run check:ota-paths
//   node scripts/check-ota-trigger-paths.mjs --json   (machine-readable)

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const WORKFLOW = '.github/workflows/eas-update.yml'

// Top-level entries under mobile/ that do NOT enter the Metro bundle, and
// therefore must NOT appear in the publish trigger. Every one of these was
// reachable by the old `mobile/**` denylist — i.e. each was a live way to
// publish a no-op OTA. Add to this map when you add a non-bundle entry.
const NON_BUNDLE = {
  docs: 'Runbooks. Never bundled. (#1455 excluded these after #1451 published from a docs-only push.)',
  'asc-screenshots': 'App Store listing images, uploaded to ASC by hand. Capturing fresh ones is a launch step — see mobile/docs/store-release-one-app.md §4.',
  certs: 'EAS Update code-signing key material. Inert (Enterprise-plan-only, see docs/eas-update-code-signing.md) and native-side regardless.',
  scripts: 'Developer tools run by hand (bump-version.mjs, resize-screenshots.sh). Not imported by the app.',
  'eas.json': 'EAS build/submit profiles. Affects `eas build`, not the JS bundle.',
  '.eas': 'EAS Workflows build orchestration (.eas/workflows/release.yml). Build-time, not bundle-time.',
  '.audit-allowlist.json': 'check:dependency-audit:mobile gate config. (#1434 published a no-op OTA from a change to this file alone.)',
  '.env.example': 'Documentation of env var names. Real values come from EAS env / app.config.js.',
  '.gitignore': 'Git metadata.',
}

// shared/ is deliberately wholesale — see the workflow comment. Narrowing
// it needs a real proof of which modules the bundle pulls transitively, so
// the guard pins it rather than letting it be quietly trimmed.
const REQUIRED_PATTERNS = ['shared/**']

/**
 * Extract `on.push.paths` from the workflow.
 *
 * Hand-rolled rather than js-yaml: the only YAML parsers in the tree are
 * undeclared transitive deps, and a guard that silently stops working
 * because a dependency moved is worse than no guard. This throws on
 * anything it does not recognise — it must never degrade to "found no
 * patterns, therefore clean".
 */
export function parseTriggerPaths(yamlText) {
  const lines = yamlText.split('\n')
  // Find `paths:` nested under a `push:` block (skip any other paths: key).
  let inPush = false
  let pathsIndent = -1
  const patterns = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*#/.test(line) || line.trim() === '') continue
    const indent = line.length - line.trimStart().length

    if (/^\s*push:\s*$/.test(line)) {
      inPush = true
      continue
    }
    if (inPush && pathsIndent === -1) {
      // Any key at or left of `push:`'s own indent ends the push block.
      if (/^\s*paths:\s*$/.test(line)) {
        pathsIndent = indent
        continue
      }
      if (/^\s*\S+:/.test(line) && indent <= 2) inPush = false
      continue
    }
    if (pathsIndent !== -1) {
      const item = line.match(/^\s*-\s*(.+?)\s*$/)
      if (item && indent > pathsIndent) {
        patterns.push(item[1].replace(/^['"]|['"]$/g, ''))
        continue
      }
      break // list ended
    }
  }

  if (!patterns.length) {
    throw new Error(
      `Could not parse any patterns from \`on.push.paths\` in ${WORKFLOW}. ` +
        `Refusing to report "clean" — fix this parser before trusting the check.`
    )
  }
  return patterns
}

/** Compile one GitHub Actions path glob to a RegExp. */
export function globToRegExp(glob) {
  if (glob.includes('+')) {
    throw new Error(
      `Pattern "${glob}" uses \`+\` (extglob "one or more"), which this checker does not model. ` +
        `Rewrite the pattern or teach globToRegExp about it — do not let it match by accident.`
    )
  }
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*' // ** crosses path separators
        i++
      } else {
        re += '[^/]*' // * stops at a separator
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/**
 * Is one changed file included by the filter?
 * Last matching pattern wins (GitHub's documented ordering rule).
 * Note: `**` matches dotfiles — empirically confirmed by run 2ce8971c,
 * which fired on `mobile/.audit-allowlist.json` alone under `mobile/**`.
 */
export function isIncluded(file, patterns) {
  let included = false
  for (const p of patterns) {
    const negated = p.startsWith('!')
    const glob = negated ? p.slice(1) : p
    if (globToRegExp(glob).test(file)) included = !negated
  }
  return included
}

/** Would a push of exactly these files run the workflow? */
export function wouldFire(files, patterns) {
  return files.some((f) => isIncluded(f, patterns))
}

/**
 * Top-level entries under mobile/ that git would carry.
 *
 * Enumerated from the INDEX + WORKING TREE, not from HEAD. That distinction
 * is the whole point: CLAUDE.md puts `check:ota-paths` in the CI mirror you
 * run BEFORE `git commit`, and the ship loop is branch → changes + mirror →
 * commit → push. `git ls-tree HEAD mobile/` reads the last commit, so a
 * developer who creates mobile/hooks/ and runs the mirror would be told
 * "OTA trigger paths: clean" — the one message this design depends on being
 * trustworthy — and would only learn otherwise once the directory was
 * already on main, silently publishing nothing.
 *
 * `--cached` covers tracked + staged, `--others --exclude-standard` covers
 * untracked-but-not-gitignored. `-z` because filenames may contain spaces
 * or, in this repo, parentheses.
 */
function trackedMobileEntries(root) {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'mobile/'],
    { cwd: root, encoding: 'utf8' }
  )
  const entries = new Set()
  for (const p of out.split('\0')) {
    if (!p) continue
    const rel = p.replace(/^mobile\//, '')
    if (!rel) continue
    entries.add(rel.split('/')[0]) // top-level entry only
  }
  return [...entries].sort()
}

function main() {
  const json = process.argv.includes('--json')
  const yamlText = fs.readFileSync(path.join(repoRoot, WORKFLOW), 'utf8')
  const patterns = parseTriggerPaths(yamlText)
  const entries = trackedMobileEntries(repoRoot)

  const positives = patterns.filter((p) => !p.startsWith('!'))
  const negatives = patterns.filter((p) => p.startsWith('!'))

  const unclassified = []
  const doubleClassified = []
  const covered = []

  for (const entry of entries) {
    const abs = path.join(repoRoot, 'mobile', entry)
    const isDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory()
    const probe = isDir ? `mobile/${entry}/__probe__` : `mobile/${entry}`
    const triggers = isIncluded(probe, patterns)
    const declaredNonBundle = Object.hasOwn(NON_BUNDLE, entry)

    if (triggers && declaredNonBundle) doubleClassified.push(entry)
    else if (triggers) covered.push(entry)
    else if (!declaredNonBundle) unclassified.push(entry)
  }

  // A NON_BUNDLE entry that no longer exists is stale bookkeeping.
  const stale = Object.keys(NON_BUNDLE).filter((e) => !entries.includes(e)).sort()

  // A trigger pattern pointing at a mobile path that no longer exists is a
  // silently-dead trigger (a rename would produce exactly this).
  const deadPatterns = positives
    .filter((p) => p.startsWith('mobile/'))
    .filter((p) => {
      const top = p.split('/')[1].replace(/\*+$/, '')
      return top && !entries.includes(top)
    })

  const missingRequired = REQUIRED_PATTERNS.filter((p) => !patterns.includes(p))

  // Under an allowlist, a negation is redundant at best and the first step
  // back toward a denylist at worst.
  const strayNegations = negatives

  const problems =
    unclassified.length +
    doubleClassified.length +
    stale.length +
    deadPatterns.length +
    missingRequired.length +
    strayNegations.length

  if (json) {
    console.log(
      JSON.stringify(
        { ok: problems === 0, patterns, covered, unclassified, doubleClassified, stale, deadPatterns, missingRequired, strayNegations },
        null,
        2
      )
    )
    process.exit(problems === 0 ? 0 : 1)
  }

  if (problems === 0) {
    console.log(`\n\x1b[1mOTA trigger paths: clean\x1b[0m`)
    console.log(
      `  ${entries.length} top-level entries under mobile/ — ${covered.length} bundle (trigger a publish), ` +
        `${Object.keys(NON_BUNDLE).length} non-bundle (inert).`
    )
    // Say what this check does NOT cover, so "clean" is not read as more
    // than it is. Both lines are accepted design, not undiscovered risk.
    console.log(
      `  Not inspected: shared/** (wholesale by design — every entry under it publishes,`
    )
    console.log(
      `  including its ${'`'}*.test.js${'`'}/__tests__/__fixtures__; nothing there can be UNDER-published).`
    )
    console.log(
      `  Advisory, not a gate: main has no branch protection, so a red run blocks no merge.\n`
    )
    process.exit(0)
  }

  console.error(`\n\x1b[1mOTA trigger paths: ${problems} problem${problems === 1 ? '' : 's'}\x1b[0m`)

  if (unclassified.length) {
    console.error(`\n  UNCLASSIFIED — new under mobile/, and nothing says whether it ships to phones:`)
    for (const e of unclassified) console.error(`    ? mobile/${e}`)
    console.error(`\n  Decide, then record the decision:`)
    console.error(`    - enters the Metro bundle → add a pattern to \`on.push.paths\` in ${WORKFLOW}`)
    console.error(`    - does not               → add it to NON_BUNDLE in scripts/check-ota-trigger-paths.mjs, with a reason`)
    console.error(`  Defaulting is not an option here: guessing "bundle" publishes a no-op OTA to production`)
    console.error(`  phones, guessing "non-bundle" means a real fix silently never ships.`)
  }
  if (doubleClassified.length) {
    console.error(`\n  CONTRADICTION — both triggers a publish AND is declared non-bundle:`)
    for (const e of doubleClassified) console.error(`    ! mobile/${e}`)
    console.error(`  Remove it from one side.`)
  }
  if (stale.length) {
    console.error(`\n  STALE NON_BUNDLE entries (no longer in the tree — drop them):`)
    for (const e of stale) console.error(`    - mobile/${e}`)
  }
  if (deadPatterns.length) {
    console.error(`\n  DEAD TRIGGER PATTERNS (match nothing in the tree — a rename would do this):`)
    for (const p of deadPatterns) console.error(`    - ${p}`)
    console.error(`  A dead pattern means those files no longer publish. Repoint it.`)
  }
  if (missingRequired.length) {
    console.error(`\n  MISSING REQUIRED PATTERN:`)
    for (const p of missingRequired) console.error(`    - ${p}`)
    console.error(`  shared/** is wholesale on purpose — mobile pulls it transitively and the set churns,`)
    console.error(`  so a missed OTA for a real shared change beats an extra publish for a web-only one.`)
    console.error(`  Narrowing it needs proof of the true import closure; change REQUIRED_PATTERNS deliberately.`)
  }
  if (strayNegations.length) {
    console.error(`\n  NEGATION IN AN ALLOWLIST — this is the denylist creeping back:`)
    for (const p of strayNegations) console.error(`    - ${p}`)
    console.error(`  Under a positive allowlist an excluded path already never matches. Delete the negation`)
    console.error(`  and, if something is over-triggering, narrow the positive pattern instead.`)
  }
  console.error('')
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
