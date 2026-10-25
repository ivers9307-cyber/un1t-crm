// CHANGELOG-FILES.1: one file per PR under docs/changelog/entries, so no two
// PRs edit the same file (GitHub ignores merge=union, and every merge used to
// make the other open PRs conflict on docs/CHANGELOG.md).
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readEntries } from '../scripts/changelog.mjs'

const DIR = 'docs/changelog/entries'

describe('changelog entries', () => {
  const files = readdirSync(DIR).filter((f) => f !== 'README.md')

  it('every entry file is named <PR number>.md', () => {
    for (const f of files) expect(f, f).toMatch(/^\d+\.md$/)
  })

  it('every entry is exactly one table row keyed by its own PR number', () => {
    for (const f of files) {
      const lines = readFileSync(join(DIR, f), 'utf8').split('\n').filter((l) => l.trim() !== '')
      expect(lines.length, `${f}: one row`).toBe(1)
      const pr = f.replace(/\.md$/, '')
      expect(lines[0], f).toMatch(new RegExp(`^\\| #${pr} \\| .+ \\| .+ \\|$`))
    }
  })

  it('the reader lists entries newest first', () => {
    const prs = readEntries(DIR).map((e) => e.pr)
    expect(prs).toEqual([...prs].sort((a, b) => b - a))
  })
})
