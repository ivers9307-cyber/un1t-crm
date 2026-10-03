// tests/labour-owner-gate.test.js
// LABOUR.1 — labour against revenue carries pay (with one coach at a studio,
// the total IS their pay). It is owner-only by ROLE and web-only. A floor, not
// a proof: it reads source text, like the other guard sweeps in tests/.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(repo, p), 'utf8')

describe('LABOUR.1 owner gate', () => {
  it('the Business page renders the labour block once, behind canSeeLabour(user)', () => {
    const src = read('src/app/dashboard/business/page.js')
    expect(src).toContain('const showLabour = canSeeLabour(user)')
    expect(src.split('<LabourBlock').length - 1).toBe(1)
    const at = src.indexOf('<LabourBlock')
    expect(src.slice(Math.max(0, at - 200), at)).toContain('showLabour ?')
  })

  it('the phone Business route never carries labour', () => {
    const src = read('src/app/api/dashboard/business/route.js')
    expect(src).not.toMatch(/labour-month|LabourBlock|LabourPanel/)
  })

  it('the panel and block are not client components', () => {
    for (const f of ['src/components/dashboard/LabourPanel.jsx', 'src/components/dashboard/LabourBlock.jsx']) {
      expect(read(f)).not.toMatch(/['"]use client['"]/)
    }
  })
})
