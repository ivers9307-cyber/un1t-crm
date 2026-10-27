// CARDLENS.9 review — the contact page is an async server component the tests
// only read as text, and `next build` does not run it, so a `const` read
// before its declaration (a TDZ ReferenceError on EVERY render) passed every
// gate once. ESLint's no-use-before-define sees it statically.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { Linter } from 'eslint'

const ROOT = path.resolve(import.meta.dirname, '..')
const FILE = 'src/app/(sales)/contacts/[id]/page.js'

describe('the contact page reads no variable before it is declared', () => {
  it('no-use-before-define (variables) is clean', () => {
    const messages = new Linter({ configType: 'flat' }).verify(readFileSync(path.join(ROOT, FILE), 'utf8'), [{
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
      rules: { 'no-use-before-define': ['error', { functions: false, classes: false, variables: true }] },
    }], FILE)
    expect(messages.map((m) => `${m.line}: ${m.message}`)).toEqual([])
  })
})
