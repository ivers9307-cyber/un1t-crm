// WASTUDIOPICK.1 — picker settings. Fictional ids only.
import { describe, it, expect, vi } from 'vitest'
vi.mock('../log', () => ({ logWarn: vi.fn() }))
import { readPickerConfig, pickerLabel, DEFAULT_PICKER_QUESTION } from './config.js'
import { logWarn } from '../log'
import { fakeWhatsAppDb, link } from '../whatsapp-numbers-fake-db.test-helpers.js'

const ORG = 'd0000000-0000-4000-8000-000000000001'
const STILL = { id: 'a1', name: 'UN1T Stillorgan', organization_id: ORG, settings: { wa_studio_picker: { enabled: true, listed: true, label: 'Stillorgan', keywords: ['stillorgan'] } } }
const HATCH = { id: 'a2', name: 'UN1T Hatch Street', organization_id: ORG, settings: { wa_studio_picker: { listed: true } } }
const TEST = { id: 'a3', name: 'Test Studio', organization_id: ORG, settings: {} }
const OTHER = { id: 'a9', name: 'Elsewhere', organization_id: 'd0000000-0000-4000-8000-000000000009', settings: { wa_studio_picker: { listed: true } } }

// `numbers` are whatsapp_numbers rows (each switched on at its home studio unless
// `links` says otherwise, WAORGNUMBER.1); `numbersFault` fails only the link read.
function makeDb(rows, fault, { numbers = [], links, numbersFault = null } = {}) {
  return fakeWhatsAppDb({
    locations: rows,
    numbers,
    links,
    faults: { ...(fault ? { locations: fault } : {}), ...(numbersFault ? { location_whatsapp_numbers: numbersFault } : {}) },
  })
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
  const HATCH_NO = { id: 'n2', location_id: 'a2', is_active: true }
  it('a listed sibling with an active number is not offered; the receiving studio (with its number) stays', async () => {
    const cfg = await readPickerConfig(makeDb([STILL, HATCH, TEST], null, { numbers: [{ id: 'n1', location_id: 'a1', is_active: true }, HATCH_NO] }), 'a1')
    expect(cfg.studios.map((s) => s.id)).toEqual(['a1'])
  })
  it('a sibling the organisation number is switched on at is not offered (WAORGNUMBER.1)', async () => {
    const org = { id: 'n1', location_id: 'a1', is_active: true }
    const cfg = await readPickerConfig(makeDb([STILL, HATCH, TEST], null, { numbers: [org], links: [link('a1', 'n1'), link('a2', 'n1')] }), 'a1')
    expect(cfg.studios.map((s) => s.id)).toEqual(['a1'])
  })
  it('a sibling that owns a number but has it switched off there is still offered (WAORGNUMBER.1)', async () => {
    const cfg = await readPickerConfig(makeDb([STILL, HATCH], null, { numbers: [HATCH_NO], links: [] }), 'a1')
    expect(cfg.studios.map((s) => s.id).sort()).toEqual(['a1', 'a2'])
  })
  it('an inactive number does not exclude the sibling', async () => {
    const cfg = await readPickerConfig(makeDb([STILL, HATCH], null, { numbers: [{ id: 'n2', location_id: 'a2', is_active: false }] }), 'a1')
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
