// registration-entry is the browser-safe half of the entry move: a client
// component imports it, so it must never reach the service-role client.
// The probe: mocking @/lib/supabase records whether anything loaded it.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const probe = vi.hoisted(() => ({ supabaseLoaded: false }))
vi.mock('@/lib/supabase', () => {
  probe.supabaseLoaded = true
  return { createServerClient: () => null }
})

describe('registration-entry is browser-safe', () => {
  it('imports nothing at all', () => {
    const src = readFileSync(path.resolve(import.meta.dirname, 'registration-entry.js'), 'utf8')
    expect(src).not.toMatch(/^\s*import\s/m)
    expect(src).not.toMatch(/\bimport\s*\(|\brequire\s*\(/)
  })

  it('loading it does not load @/lib/supabase; loading registration-move does', async () => {
    const entry = await import('./registration-entry.js')
    expect(Object.keys(entry).sort()).toEqual([
      'MOVE_ERRORS', 'MOVE_ERROR_MESSAGES', 'computePriceGapCents', 'entryHeadcount', 'entryLabel', 'membersOf', 'perPersonFeeCents',
    ].sort())
    expect(probe.supabaseLoaded).toBe(false)
    // Positive control: the server half does reach it, so the probe works.
    await import('./registration-move.js')
    expect(probe.supabaseLoaded).toBe(true)
  })

  it('registration-move re-exports the same objects', async () => {
    const entry = await import('./registration-entry.js')
    const move = await import('./registration-move.js')
    for (const name of ['MOVE_ERRORS', 'MOVE_ERROR_MESSAGES', 'entryLabel', 'entryHeadcount', 'perPersonFeeCents', 'computePriceGapCents']) {
      expect(move[name], name).toBe(entry[name])
    }
  })
})
