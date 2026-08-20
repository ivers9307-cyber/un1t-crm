// OTABLOCK.1 — executable proof that the OTA publish pipeline refuses to
// build into a blocked rollout, and that it fails OPEN when it cannot tell.
//
// The defect this pins: on 2026-08-20 the last two EAS Update runs on `main`
// failed with
//
//   "Cannot publish a new update with this runtime version while a rollout is
//    in progress for the same runtime version. Before publishing a new update,
//    the latest rollout percentage must be set to 100% or the rollout update
//    deleted."
//
// A staged rollout published at 10% had never been ramped, so every later
// publish was refused. Two merged changes never reached a device, and the only
// signal was a red workflow. Worse, the refusal arrived at the LAST step —
// after ~5 minutes of install, Metro export and a 6.6MB upload to Expo's CDN.
//
// `.github/workflows/eas-update.yml` now runs a pre-flight before any of that.
// This file runs the REAL shell out of the REAL workflow file against a stub
// `eas` binary, so the assertions are about what will actually execute, not
// about a copy of it that can drift.
//
// The fail-open cases matter as much as the blocking one. A pre-flight that
// guesses wrong about the CLI's JSON shape and starts refusing good publishes
// would be a worse bug than the one it fixes — so anything the check cannot
// read (CLI error, unparseable output, unreadable runtimeVersion) must let the
// publish proceed exactly as it does today.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKFLOW = join(__dirname, '..', '.github', 'workflows', 'eas-update.yml')

/**
 * Pull one step's `run:` block out of the workflow, dedented.
 *
 * Hand-rolled rather than js-yaml, for the same reason
 * scripts/check-ota-trigger-paths.mjs is: the only YAML parsers in this tree
 * are undeclared transitive deps, and a guard that silently stops working
 * because a dependency moved is worse than no guard. It THROWS when it cannot
 * find the step — it must never degrade into "no script found, therefore the
 * tests pass".
 */
function extractRun(yamlText, stepNamePrefix) {
  const lines = yamlText.split('\n')
  let i = lines.findIndex((l) => {
    const m = l.match(/^\s*-\s*name:\s*(.+?)\s*$/)
    return m && m[1].startsWith(stepNamePrefix)
  })
  if (i === -1) {
    throw new Error(
      `No step named "${stepNamePrefix}…" in ${WORKFLOW}. If the step was renamed, ` +
        `rename it here too — do not delete this test to make it pass.`,
    )
  }
  const stepIndent = lines[i].length - lines[i].trimStart().length
  for (i += 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    // A new `- name:` at the same indent means we walked past the step.
    if (indent <= stepIndent && /^\s*-\s/.test(line)) break
    if (/^\s*run:\s*\|\s*$/.test(line)) {
      const body = []
      const bodyIndent = lines[i + 1].length - lines[i + 1].trimStart().length
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]
        if (l.trim() !== '' && l.length - l.trimStart().length < bodyIndent) break
        body.push(l.slice(bodyIndent))
      }
      return body.join('\n')
    }
  }
  throw new Error(`Step "${stepNamePrefix}…" has no \`run: |\` block in ${WORKFLOW}.`)
}

const APP_CONFIG_WITH_RUNTIME = [
  'module.exports = {',
  // `version` sits above `runtimeVersion` in the real file and they are
  // separate literals — the extraction must not pick this one up.
  "  version: '9.9.9',",
  "  runtimeVersion: '2.3.0',",
  '}',
  '',
].join('\n')

let script
let root

/** Run the pre-flight with a stub `eas` that prints `easStdout`. */
function runPreflight({ easStdout = '', easExit = 0, appConfig = APP_CONFIG_WITH_RUNTIME } = {}) {
  const work = mkdtempSync(join(root, 'work-'))
  const bin = join(work, 'bin')
  mkdirSync(bin)
  const payload = join(work, 'eas-stdout.txt')
  writeFileSync(payload, easStdout)
  const stub = join(bin, 'eas')
  writeFileSync(
    stub,
    ['#!/bin/bash', `cat "${payload}"`, easExit === 0 ? 'exit 0' : 'echo "stub failure" >&2; exit 1', ''].join('\n'),
  )
  chmodSync(stub, 0o755)

  const cwd = join(work, 'mobile')
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'app.config.js'), appConfig)
  const scriptPath = join(work, 'preflight.sh')
  writeFileSync(scriptPath, script)

  const summary = join(work, 'summary.md')
  const envFile = join(work, 'env.txt')
  writeFileSync(summary, '')
  writeFileSync(envFile, '')

  const res = spawnSync('bash', [scriptPath], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_ENV: envFile,
    },
  })
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    summary: readFileSync(summary, 'utf8'),
    env: readFileSync(envFile, 'utf8'),
    leftovers: readdirSync(cwd),
  }
}

beforeAll(() => {
  script = extractRun(readFileSync(WORKFLOW, 'utf8'), 'Pre-flight')
  root = mkdtempSync(join(tmpdir(), 'ota-preflight-'))
})
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('OTA pre-flight — the blocking case', () => {
  // The exact shape observed from the blocked runs: a group at 10% on the live
  // 2.3.0 lane, with the per-platform updates nested inside it.
  const blocked = JSON.stringify({
    currentPage: [
      {
        group: 'abc-123',
        message: 'TOKENDEAD.1 — restore the un1t colour tokens',
        runtimeVersion: '2.3.0',
        rolloutPercentage: 10,
        updates: [
          { id: 'ios-1', platform: 'ios', runtimeVersion: '2.3.0', rolloutPercentage: 10 },
          { id: 'android-1', platform: 'android', runtimeVersion: '2.3.0', rolloutPercentage: 10 },
        ],
      },
      { group: 'older-9', runtimeVersion: '2.3.0', rolloutPercentage: 100 },
    ],
  })

  it('ABORTS when a rollout on the same runtime is part-way through', () => {
    const r = runPreflight({ easStdout: blocked })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('::error::OTA publish blocked')
  })

  it('names the blocked group, its percentage and its message in the job summary', () => {
    const { summary } = runPreflight({ easStdout: blocked })
    expect(summary).toContain('OTA publish BLOCKED')
    expect(summary).toContain('abc-123')
    expect(summary).toContain('10%')
    expect(summary).toContain('TOKENDEAD.1')
    // The operator needs the ramp command, not a GraphQL error.
    expect(summary).toContain('update:edit')
    expect(summary).toContain('--rollout-percentage 100')
    expect(summary).toContain('mobile/docs/ota-rollout.md')
  })

  it('reports ONE stuck group, not one per nested platform update', () => {
    const { summary } = runPreflight({ easStdout: blocked })
    const rows = summary.split('\n').filter((l) => l.startsWith('- group '))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('abc-123')
    // The nested per-platform ids must not surface as separate rollouts.
    expect(summary).not.toContain('ios-1')
  })

  it('flags ROLLOUT_BLOCKED so the notify step can explain the real cause', () => {
    const { env } = runPreflight({ easStdout: blocked })
    expect(env).toContain('ROLLOUT_BLOCKED=1')
  })

  it('does NOT ramp or delete anything — the interlock is left standing', () => {
    // Auto-ramping would defeat the interlock; auto-deleting would discard an
    // update some devices already have. So: the ONLY eas subcommand this step
    // may actually invoke is the read-only `update:list`. The mutating verbs
    // are allowed to appear as TEXT — the job summary prints the ramp command
    // for a human — so the assertion is about invocation, not about the word.
    const invocations = script
      .split('\n')
      .map((l) => l.trim())
      // Lines opening with a quote or a comment are JS string / comment
      // content inside the heredoc, not shell the runner will execute.
      .filter((l) => !l.startsWith("'") && !l.startsWith('//') && !l.startsWith('#'))
      .filter((l) => /\beas(-cli\S*)?\s+\S/.test(l))
    expect(invocations).toHaveLength(1)
    expect(invocations[0]).toContain('update:list')
    expect(invocations[0]).not.toMatch(/update:(edit|delete|republish)|roll-back-to-embedded/)
    // …while the human-facing ramp instruction IS present in the summary text.
    expect(script).toContain('npx eas-cli@18.9.1 update:edit <GROUP_ID>')
  })

  it('matches a bare-array page shape too (eas-cli has moved this)', () => {
    const bare = JSON.stringify([{ group: 'g', runtimeVersion: '2.3.0', rolloutPercentage: 42 }])
    const r = runPreflight({ easStdout: bare })
    expect(r.status).toBe(1)
    expect(r.summary).toContain('42%')
  })
})

describe('OTA pre-flight — the cases that must let the publish through', () => {
  it('passes when the latest rollout is fully ramped to 100%', () => {
    const r = runPreflight({
      easStdout: JSON.stringify({ currentPage: [{ group: 'g', runtimeVersion: '2.3.0', rolloutPercentage: 100 }] }),
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('clear to publish')
  })

  it('ignores a rollout stuck on a DIFFERENT runtime lane', () => {
    // The 2.2.0 hotfix lane is a separate lane; EAS scopes the refusal by
    // runtimeVersion, so a 2.2.0 partial must not block a 2.3.0 publish.
    const r = runPreflight({
      easStdout: JSON.stringify({ currentPage: [{ group: 'g', runtimeVersion: '2.2.0', rolloutPercentage: 10 }] }),
    })
    expect(r.status).toBe(0)
  })

  it('ignores updates that carry no rolloutPercentage at all', () => {
    const r = runPreflight({
      easStdout: JSON.stringify([{ group: 'g', runtimeVersion: '2.3.0' }]),
    })
    expect(r.status).toBe(0)
  })

  it('FAILS OPEN when the eas CLI errors — a network blip must not eat an OTA', () => {
    const r = runPreflight({ easStdout: '', easExit: 1 })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('fail-open')
  })

  it('FAILS OPEN when the CLI prints something that is not JSON', () => {
    const r = runPreflight({ easStdout: 'Checking for updates...\nnot json' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('fail-open')
  })

  it('FAILS OPEN when runtimeVersion cannot be read from app.config.js', () => {
    const r = runPreflight({
      easStdout: JSON.stringify([{ group: 'g', runtimeVersion: '2.3.0', rolloutPercentage: 10 }]),
      appConfig: "module.exports = { version: '2.3.0' }\n",
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('fail-open')
  })

  it('reads the runtimeVersion literal, not the `version` literal above it', () => {
    // app.config.js carries both, and they are deliberately separate values —
    // matching the wrong one would scope the check to a lane that does not
    // exist, i.e. silently never block.
    const r = runPreflight({
      easStdout: JSON.stringify([{ group: 'g', runtimeVersion: '9.9.9', rolloutPercentage: 10 }]),
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Runtime lane about to be published: 2.3.0')
  })
})

describe('OTA pre-flight — hygiene', () => {
  it('leaves no scratch files behind in mobile/', () => {
    const r = runPreflight({ easStdout: JSON.stringify([{ group: 'g', runtimeVersion: '2.3.0', rolloutPercentage: 100 }]) })
    expect(r.leftovers).toEqual(['app.config.js'])
  })

  it('runs BEFORE the install and the publish, so a block costs no bundle', () => {
    const wf = readFileSync(WORKFLOW, 'utf8')
    const at = (name) => wf.indexOf(`- name: ${name}`)
    const preflight = wf.indexOf('- name: Pre-flight')
    expect(preflight).toBeGreaterThan(-1)
    expect(preflight).toBeLessThan(at('Install dependencies'))
    expect(preflight).toBeLessThan(at('Publish update'))
  })
})
