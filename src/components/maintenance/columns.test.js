// EQUIP-MAINT.1f — protects the blank-column defect found at final
// review: cellValue() (src/components/ui/styles.js) only resolves a
// cell via `accessor` or `render` — a column with neither renders
// blank. `key` is only a React key, never a value source. Because
// nothing in this app actually renders these tables under vitest
// (no jsdom/testing-library here), build/lint/tests all passed while
// the Equipment/Type name columns were silently blank. This test
// exercises the REAL column builders against the REAL cellValue so a
// future column added without accessor/render fails here instead of
// shipping invisible.

import { describe, it, expect } from 'vitest'
import { cellValue } from '@/components/ui'
import { buildEquipmentColumns } from './EquipmentTab.jsx'
import { buildTypeColumns } from './TypesTab.jsx'
import { buildDueColumns } from './DueTab.jsx'

const EQUIPMENT_ROW = {
  id: 'eq-1',
  name: 'Treadmill 3',
  type_id: 'type-1',
  equipment_types: { id: 'type-1', name: 'Treadmill' },
  zone: 'Cardio floor',
  status: 'in_service',
  last_inspected_on: '2026-07-20',
  next_due_on: '2026-08-04',
}

const TYPE_ROW = {
  id: 'type-1',
  name: 'Treadmill',
  interval_weeks: 4,
  items: [{ id: 'a', label: 'Check belt wear', order: 0 }],
  enabled: true,
}

describe('EquipmentTab columns', () => {
  const columns = buildEquipmentColumns('2026-07-31')

  it('every column resolves a defined value for a representative row', () => {
    for (const column of columns) {
      expect(cellValue(EQUIPMENT_ROW, column), `column "${column.key}" (${column.header})`)
        .toBeDefined()
    }
  })

  it('the Equipment (name) column reads the asset name — the regressed column', () => {
    const nameColumn = columns.find((c) => c.key === 'name')
    expect(cellValue(EQUIPMENT_ROW, nameColumn)).toBe('Treadmill 3')
  })
})

describe('TypesTab columns', () => {
  const columns = buildTypeColumns()

  it('every column resolves a defined value for a representative row', () => {
    for (const column of columns) {
      expect(cellValue(TYPE_ROW, column), `column "${column.key}" (${column.header})`)
        .toBeDefined()
    }
  })

  it('the Type (name) column reads the type name — the regressed column', () => {
    const nameColumn = columns.find((c) => c.key === 'name')
    expect(cellValue(TYPE_ROW, nameColumn)).toBe('Treadmill')
  })
})

const DUE_ROW = {
  id: 'eq-1',
  name: 'Treadmill 3',
  type_id: 'type-1',
  equipment_types: { id: 'type-1', name: 'Treadmill', interval_weeks: 4 },
  zone: 'Cardio floor',
  status: 'in_service',
  next_due_on: '2026-07-25',
}

describe('DueTab columns', () => {
  const columns = buildDueColumns({ today: '2026-07-31', onInspect: () => {} })

  it('every column resolves a defined value for a representative row', () => {
    for (const column of columns) {
      expect(cellValue(DUE_ROW, column), `column "${column.key}" (${column.header})`)
        .toBeDefined()
    }
  })

  it('the Equipment (name) column reads the asset name — the regressed column', () => {
    const nameColumn = columns.find((c) => c.key === 'name')
    expect(cellValue(DUE_ROW, nameColumn)).toBe('Treadmill 3')
  })
})
