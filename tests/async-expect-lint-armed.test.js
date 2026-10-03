// D2 EXPECTLINT.1 — `guardrails/no-unawaited-async-expect` is ARMED where the
// tests live. tests/guardrails-rules.test.js proves the rule's logic; this
// proves the configs the gate runs actually apply it: `check:guardrails`
// (eslint.guardrails.config.mjs) for src/, shared/ and tests/, and
// `check:mobile-lint` (eslint.mobile.config.mjs) for mobile/lib. A rule that
// exists but is not armed for a path is the silent gap this file is for.
import { describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RULE = 'guardrails/no-unawaited-async-expect'
// Loading a flat config (plus next's and react's plugins) takes a few seconds.
const LINT_TIMEOUT_MS = 30_000

// The #1762 shape: an async assertion nothing waits for.
const FLOATING = [
  "import { it, expect } from 'vitest'",
  "it('x', async () => { expect(Promise.resolve(1)).resolves.toBe(1) })",
  '',
].join('\n')

async function ruleHits(configFile, filePath, code = FLOATING) {
  const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: configFile })
  const [result] = await eslint.lintText(code, { filePath })
  return result.messages.filter((m) => m.ruleId === RULE).length
}

describe('no-unawaited-async-expect is armed where tests live (D2 EXPECTLINT.1)', () => {
  it.each([
    'src/lib/zz-expectlint.test.js',
    'src/components/zz-expectlint.test.jsx',
    'shared/zz-expectlint.test.js',
    'tests/zz-expectlint.test.js',
    'tests/helpers/zz-expectlint.js',
    'src/lib/zz-expectlint.test-helpers.js',
    'src/app/api/zz/_test-expectlint.js',
  ])('check:guardrails flags a floating async assertion in %s', async (filePath) => {
    expect(await ruleHits('eslint.guardrails.config.mjs', filePath)).toBe(1)
  }, LINT_TIMEOUT_MS)

  it('check:mobile-lint flags a floating async assertion in mobile/lib', async () => {
    expect(await ruleHits('eslint.mobile.config.mjs', 'mobile/lib/zz-expectlint.test.js')).toBe(1)
  }, LINT_TIMEOUT_MS)

  it('an awaited one passes both', async () => {
    const awaited = FLOATING.replace('{ expect(', '{ await expect(')
    expect(await ruleHits('eslint.guardrails.config.mjs', 'src/lib/zz-expectlint.test.js', awaited)).toBe(0)
    expect(await ruleHits('eslint.mobile.config.mjs', 'mobile/lib/zz-expectlint.test.js', awaited)).toBe(0)
  }, LINT_TIMEOUT_MS)
})
