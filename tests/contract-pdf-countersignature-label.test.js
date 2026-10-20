// CONTRACTS-PDF.2 — the countersignature label printed on the ARCHIVED PDF.
//
// Same as the web label for every contract issued since LEGALENT.1 (the
// frozen legal_entity_name). For a legacy contract (no frozen entity) the
// PDF prefers the employer the body itself names (variables_data
// .employer_name) over the retired literal the web pages keep rendering;
// only a row with neither falls back to the legacy label. Richard's call,
// 20 Oct 2026, rebuilding Mark Doyle's copy for the WRC inspection.
import { describe, it, expect } from 'vitest'
import {
  contractPdfCountersignatureLabel,
  contractCountersignatureLabel,
  LEGACY_COUNTERSIGNATURE_ENTITY,
} from '../src/lib/contracting-entity.js'

describe('contractPdfCountersignatureLabel', () => {
  it('a frozen legal_entity_name wins, exactly as on the web pages', () => {
    const row = { variables_data: { legal_entity_name: 'Champ Fitness Ltd (trading as UN1T Dublin)', employer_name: 'Champ fitness LTD' } }
    expect(contractPdfCountersignatureLabel(row)).toBe('Champ Fitness Ltd (trading as UN1T Dublin)')
    expect(contractPdfCountersignatureLabel(row)).toBe(contractCountersignatureLabel(row))
  })

  it('a legacy contract names the employer its body was rendered with', () => {
    expect(contractPdfCountersignatureLabel({ variables_data: { employer_name: 'Champ fitness LTD' } })).toBe('Champ fitness LTD')
    // whitespace-only entity is "no entity"
    expect(contractPdfCountersignatureLabel({ variables_data: { legal_entity_name: '  ', employer_name: ' Champ fitness LTD ' } })).toBe('Champ fitness LTD')
  })

  it('with neither frozen value it falls back to the legacy label, like the web', () => {
    for (const row of [
      { variables_data: {} },
      { variables_data: { employer_name: '' } },
      { variables_data: { employer_name: 42 } },
      { variables_data: null },
      {},
      null,
    ]) {
      expect(contractPdfCountersignatureLabel(row)).toBe(LEGACY_COUNTERSIGNATURE_ENTITY)
      expect(contractPdfCountersignatureLabel(row)).toBe(contractCountersignatureLabel(row))
    }
  })

  it('never returns an empty string', () => {
    expect(contractPdfCountersignatureLabel({ variables_data: { legal_entity_name: '', employer_name: '' } })).not.toBe('')
  })
})
