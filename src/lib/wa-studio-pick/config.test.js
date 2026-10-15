// WASTUDIOPICK.1 — picker settings. Fictional ids only.
import { describe, it, expect, vi } from 'vitest'
vi.mock('../log', () => ({ logWarn: vi.fn() }))
import { readPickerConfig, pickerLabel, DEFAULT_PICKER_QUESTION } from './config.js'
import { logWarn } from '../log'

const ORG = 'd0000000-0000-4000-8000-000000000001'
const STILL = { id: 'a1', name: 'UN1T Stillorgan', organization_id: ORG, settings: { wa_studio_picker: { enabled: true, listed: true, label: 'Stillorgan', keywords: ['stillorgan'] } } }
const HATCH = { id: 'a2', name: 'UN1T Hatch Street', organization_id: ORG, settings: { wa_studio_picker: { listed: true } } }
const TEST = { id: 'a3', name: 'Test Studio', organization_id: ORG, settings: {} }
const OTHER = { id: 'a9', name: 'Elsewhere', organization_id: 'd0000000-0000-4000-8000-000000000009', settings: { wa_studio_picker: { listed: true } } }

// `numbers` are whatsapp_numbers rows; `numbersFault` fails only that read.
function makeDb(rows, fault, { numbers = [], numbersFault = null } = {}) {
  return {
    from: (table) => {
      const filters = []
      const source = table === 'whatsapp_numbers' ? numbers : rows
      const err = table === 'whatsapp_numbers' ? numbersFault : fault
      const run = () => (err ? { data: null, error: err } : { data: source.filter((r) => filters.every((f) => f(r))), error: null })
      const b = {
        select: () => b, order: () => b,
        eq: (c, v) => { filters.push((r) => r[c] === v); return b },
        in: (c, vs) => { filters.push((r) => vs.includes(r[c])); return b },
        maybeSingle: async () => { const o = run(); return o.error ? o : { data: o.data[0] ?? null, error: null } },
        then: (res, rej) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}

describe('readPickerConfig', () => {
  it('lists opted-in studios of the receiving studio\u2019s organisation, with defaults', async () => {
    const cfg = await readPickerConfig(makeDb([STILL, HATCH, TEST, OTHER]), 'a1')
    expect(cfg.enabled).toBe(true)
    expect(cfg.question).toBe(DEFAULT_PICKER_QUESTION)
    expect(cfg.studios.map((s) => s.id).sort()).toEqual(['a1', 'a2'])
    expect(cfg.studios.find((s) => s.id === 'a2')).toMatchObject({ label: 'UN1T Hatch Street', keywords: [] })
  })
  it('disabled by default; a failed read is null and logged', async () => {
    expect((await readPickerConfig(makeDb([HATCH, TEST]), 'a2')).enabled).toBe(false)
    expect(await readPickerConfig(makeDb([], { message: 'boom' }), 'a1')).toBeNull()
    expect(logWarn).toHaveBeenCalled()
  })
})

describe('readPickerConfig — studios with their own number (F2)', () => {
  const HATCH_NO = { location_id: 'a2', is_active: true }
  it('a listed sibling with an active number is not offered; the receiving studio (with its number) stays', async () => {
    const cfg = await readPickerConfig(makeDb([STILL, HATCH, TEST], null, { numbers: [{ location_id: 'a1', is_active: true }, HATCH_NO] }), 'a1')
    expect(cfg.studios.map((s) => s.id)).toEqual(['a1'])
  })
  it('an inactive number does not exclude the sibling', async () => {
    const cfg = await readPickerConfig(makeDb([STILL, HATCH], null, { numbers: [{ location_id: 'a2', is_active: false }] }), 'a1')
    expect(cfg.studios.map((s) => s.id).sort()).toEqual(['a1', 'a2'])
  })
  it('the numbers read failing → null, logged (picker skipped)', async () => {
    logWarn.mockClear()
    expect(await readPickerConfig(makeDb([STILL, HATCH], null, { numbersFault: { message: 'numbers down' } }), 'a1')).toBeNull()
    expect(logWarn).toHaveBeenCalled()
  })
})

describe('pickerLabel', () => {
  it('label, else name, cut to 20', () => {
    expect(pickerLabel({ name: 'UN1T Hatch Street Dublin 2', settings: {} })).toBe('UN1T Hatch Street Du')
    expect(pickerLabel({ name: 'x', settings: { wa_studio_picker: { label: '  Hatch Street ' } } })).toBe('Hatch Street')
  })
})
