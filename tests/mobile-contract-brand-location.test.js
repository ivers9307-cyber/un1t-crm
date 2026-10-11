// W1.S5 — the phone's contract screen names the CONTRACT's studio. The decline
// panel reads "{companyName} will be notified by email"; useBrand() with no
// argument is the staffer's ACTIVE location, which is the wrong studio for a
// contract issued from another one. The contract row carries its own
// location_id (GET /api/contracts/[id] selects it), so the screen hands that
// to useBrand, which falls back to the active location while the contract is
// still null. No RN component test runner, so pin it at source level.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { stripComments } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCREEN = path.join(ROOT, 'mobile/app/(staff)/contracts/[id].jsx')
const ROUTE = path.join(ROOT, 'src/app/api/contracts/[id]/route.js')

describe('W1.S5 — phone contract screen brand', () => {
  const code = stripComments(readFileSync(SCREEN, 'utf8'))

  it('reads the brand for the contract\'s own location', () => {
    const calls = code.match(/useBrand\([^)]*\)/g) || []
    expect(calls).toEqual(['useBrand(contract?.location_id)'])
  })

  it('declares the contract state before the brand reads it', () => {
    expect(code.indexOf('const [contract, setContract]')).toBeGreaterThan(-1)
    expect(code.indexOf('const [contract, setContract]')).toBeLessThan(code.indexOf('useBrand(contract?.location_id)'))
  })

  it('the contract GET still selects location_id', () => {
    const route = stripComments(readFileSync(ROUTE, 'utf8'))
    expect(route).toMatch(/\.from\('contracts'\)\s*\.select\(`[^`]*\blocation_id\b/)
  })
})
