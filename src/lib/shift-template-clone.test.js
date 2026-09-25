// TPLCLONE.1 — the pure half of copying shift templates between two studios of
// one organisation. The route (src/app/api/schedule/templates/clone/route.js)
// does the reads and the write; these decide what gets copied.

import { describe, it, expect } from 'vitest'
import {
  TEMPLATE_CLONE_COLUMNS,
  CLONE_SKIP_REASONS,
  templateNameKey,
  planTemplateClone,
  organizationCheck,
  cloneSourceStudios,
  cloneResultNotice,
} from './shift-template-clone'

const src = (over = {}) => ({
  id: 'src-1', location_id: 'studio-a', name: 'Early',
  start_time: '06:00:00', end_time: '09:00:00', color: '#10B981', role_label: 'Floor',
  active: true, display_order: 0, days_of_week: ['mon', 'wed'], min_coaches: 2, max_coaches: 4,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  ...over,
})

describe('templateNameKey', () => {
  it('ignores case and outer spaces, and never throws on a missing name', () => {
    expect(templateNameKey('  Early ')).toBe('early')
    expect(templateNameKey(null)).toBe('')
    expect(templateNameKey(undefined)).toBe('')
  })
})

describe('planTemplateClone', () => {
  it('by default copies the allow-listed columns verbatim EXCEPT the weekdays, and no id, studio or timestamp', () => {
    const { toCreate, skipped } = planTemplateClone({ sourceTemplates: [src()], targetTemplates: [] })
    expect(skipped).toEqual([])
    expect(toCreate).toEqual([{
      source_id: 'src-1',
      source_days_of_week: ['mon', 'wed'],
      row: {
        name: 'Early', start_time: '06:00:00', end_time: '09:00:00', color: '#10B981',
        // `[]` is the schema's "no weekdays" (mig 067: NOT NULL DEFAULT '{}',
        // "Empty array = no blocks generated"): a one-off template.
        role_label: 'Floor', days_of_week: [], min_coaches: 2, max_coaches: 4,
        active: true, display_order: 0,
      },
    }])
  })

  it('copyWeekdays: true carries the weekdays across as well', () => {
    const { toCreate } = planTemplateClone({ sourceTemplates: [src()], targetTemplates: [], copyWeekdays: true })
    expect(toCreate[0].row.days_of_week).toEqual(['mon', 'wed'])
    expect(toCreate[0].source_days_of_week).toEqual(['mon', 'wed'])
  })

  it('a source with no readable weekdays reports an empty pattern, copied or not', () => {
    const { toCreate } = planTemplateClone({ sourceTemplates: [src({ days_of_week: null })], targetTemplates: [], copyWeekdays: true })
    expect(toCreate[0].source_days_of_week).toEqual([])
    expect(toCreate[0].row.days_of_week).toEqual([])
  })

  it('copies a null role label as null (an explicit "no default role")', () => {
    const { toCreate } = planTemplateClone({ sourceTemplates: [src({ role_label: null })], targetTemplates: [] })
    expect(toCreate[0].row.role_label).toBeNull()
  })

  it('every copied column is on the allow-list, plus exactly active and display_order', () => {
    const { toCreate } = planTemplateClone({ sourceTemplates: [src()], targetTemplates: [] })
    expect(Object.keys(toCreate[0].row).sort()).toEqual([...TEMPLATE_CLONE_COLUMNS, 'active', 'display_order'].sort())
  })

  it('places the copies after the target\'s existing templates, keeping the source order', () => {
    const { toCreate } = planTemplateClone({
      sourceTemplates: [src({ id: 's1', name: 'Early' }), src({ id: 's2', name: 'Late' })],
      targetTemplates: [{ name: 'Open gym', display_order: 0 }, { name: 'Closing', display_order: 3 }],
    })
    expect(toCreate.map((p) => [p.row.name, p.row.display_order])).toEqual([['Early', 4], ['Late', 5]])
  })

  it('an empty target, or one with no readable order, starts at 0', () => {
    expect(planTemplateClone({ sourceTemplates: [src()], targetTemplates: [] }).toCreate[0].row.display_order).toBe(0)
    expect(planTemplateClone({ sourceTemplates: [src()], targetTemplates: [{ name: 'X', display_order: null }] }).toCreate[0].row.display_order).toBe(0)
    expect(planTemplateClone({ sourceTemplates: [src()], targetTemplates: null }).toCreate[0].row.display_order).toBe(0)
  })

  it('skips a name the target already has, ignoring case and outer spaces', () => {
    const { toCreate, skipped } = planTemplateClone({
      sourceTemplates: [src({ id: 's1', name: 'Early' }), src({ id: 's2', name: 'Late' })],
      targetTemplates: [{ name: ' early', display_order: 0 }],
    })
    expect(toCreate.map((p) => p.row.name)).toEqual(['Late'])
    expect(skipped).toEqual([{ source_id: 's1', name: 'Early', reason: CLONE_SKIP_REASONS.nameExists }])
  })

  it('counts the target\'s INACTIVE templates as taken names too', () => {
    const { toCreate, skipped } = planTemplateClone({
      sourceTemplates: [src()],
      targetTemplates: [{ name: 'Early', display_order: 0, active: false }],
    })
    expect(toCreate).toEqual([])
    expect(skipped[0].reason).toBe('name_exists')
  })

  it('a second source template with the same name (another case) is skipped, the first is copied', () => {
    const { toCreate, skipped } = planTemplateClone({
      sourceTemplates: [src({ id: 's1', name: 'Early' }), src({ id: 's2', name: 'EARLY' })],
      targetTemplates: [],
    })
    expect(toCreate.map((p) => p.source_id)).toEqual(['s1'])
    expect(skipped).toEqual([{ source_id: 's2', name: 'EARLY', reason: CLONE_SKIP_REASONS.duplicateInSource }])
  })

  it('default: inactive source templates are left out, and not reported', () => {
    const { toCreate, skipped } = planTemplateClone({
      sourceTemplates: [src({ id: 's1', name: 'Early' }), src({ id: 's2', name: 'Old', active: false }), src({ id: 's3', name: 'Null', active: null })],
      targetTemplates: [],
    })
    expect(toCreate.map((p) => p.source_id)).toEqual(['s1'])
    expect(skipped).toEqual([])
  })

  it('explicit ids: copies only those, and reports an inactive one and an id the source does not have', () => {
    const { toCreate, skipped } = planTemplateClone({
      sourceTemplates: [src({ id: 's1', name: 'Early' }), src({ id: 's2', name: 'Late' }), src({ id: 's3', name: 'Old', active: false })],
      targetTemplates: [],
      templateIds: ['s2', 's3', 'elsewhere'],
    })
    expect(toCreate.map((p) => p.source_id)).toEqual(['s2'])
    expect(skipped).toEqual([
      { source_id: 's3', name: 'Old', reason: 'inactive' },
      // No name: an id that is not a template of the source studio must not be
      // answered with the name of whatever row it really is.
      { source_id: 'elsewhere', name: null, reason: 'not_found' },
    ])
  })

  it('never changes its inputs', () => {
    const source = [Object.freeze({ ...src(), days_of_week: Object.freeze(['mon', 'wed']) })]
    const target = [Object.freeze({ name: 'Late', display_order: 2 })]
    Object.freeze(source); Object.freeze(target)
    expect(() => planTemplateClone({ sourceTemplates: source, targetTemplates: target, copyWeekdays: true })).not.toThrow()
  })
})

describe('organizationCheck', () => {
  const A = { id: 'studio-a', organization_id: 'org-1' }
  const B = { id: 'studio-b', organization_id: 'org-1' }
  const X = { id: 'studio-x', organization_id: 'org-2' }

  it('same organisation', () => {
    expect(organizationCheck([A, B], 'studio-a', 'studio-b')).toBe('same_org')
  })

  it('different organisations', () => {
    expect(organizationCheck([X, B], 'studio-x', 'studio-b')).toBe('cross_org')
  })

  it('an organisation that cannot be read is never "the same" (undefined === undefined)', () => {
    expect(organizationCheck([{ id: 'studio-a' }, { id: 'studio-b' }], 'studio-a', 'studio-b')).toBe('cross_org')
    expect(organizationCheck([A, { id: 'studio-b', organization_id: null }], 'studio-a', 'studio-b')).toBe('cross_org')
  })

  it('a studio missing from the rows is not_found', () => {
    expect(organizationCheck([A], 'studio-a', 'studio-b')).toBe('not_found')
    expect(organizationCheck(null, 'studio-a', 'studio-b')).toBe('not_found')
  })
})

describe('cloneSourceStudios', () => {
  const A = { id: 'studio-a', name: 'Studio A', organization_id: 'org-1' }
  const B = { id: 'studio-b', name: 'Studio B', organization_id: 'org-1' }
  const C = { id: 'studio-c', name: 'Studio C', organization_id: 'org-1' }
  const X = { id: 'studio-x', name: 'Studio X', organization_id: 'org-2' }
  const member = (locations, rolesByLocation) => ({ id: 'u1', profileRole: 'staff', locations, rolesByLocation })

  it('offers a sibling studio the caller manages', () => {
    expect(cloneSourceStudios(member([A, B], { 'studio-a': 'manager', 'studio-b': 'head_coach' }), 'studio-b'))
      .toEqual([{ id: 'studio-a', name: 'Studio A' }])
  })

  it('never offers a studio in another organisation, even to a master', () => {
    const master = { id: 'm', profileRole: 'master', locations: [C, X, A, B], rolesByLocation: {} }
    expect(cloneSourceStudios(master, 'studio-b')).toEqual([
      { id: 'studio-a', name: 'Studio A' },
      { id: 'studio-c', name: 'Studio C' },
    ])
  })

  it('never offers a sibling where the caller is only staff', () => {
    expect(cloneSourceStudios(member([A, B], { 'studio-a': 'staff', 'studio-b': 'manager' }), 'studio-b')).toEqual([])
  })

  it('offers nothing when the caller does not manage the studio on screen', () => {
    expect(cloneSourceStudios(member([A, B], { 'studio-a': 'manager', 'studio-b': 'staff' }), 'studio-b')).toEqual([])
  })

  it('offers nothing when an organisation cannot be read, on either side', () => {
    const noOrgTarget = { ...B, organization_id: null }
    expect(cloneSourceStudios(member([A, noOrgTarget], { 'studio-a': 'manager', 'studio-b': 'manager' }), 'studio-b')).toEqual([])
    const noOrgSource = { ...A, organization_id: undefined }
    expect(cloneSourceStudios(member([noOrgSource, B], { 'studio-a': 'manager', 'studio-b': 'manager' }), 'studio-b')).toEqual([])
  })

  it('a user with no locations (the old test fixtures) is offered nothing', () => {
    expect(cloneSourceStudios({ id: 'u1', role: 'manager', activeLocation: { id: 'loc1' } }, 'loc1')).toEqual([])
    expect(cloneSourceStudios(null, 'loc1')).toEqual([])
  })
})

describe('cloneResultNotice', () => {
  const made = (name) => ({ id: `new-${name}`, source_id: `src-${name}`, name })

  it('counts what was copied and the shifts it put on the calendar', () => {
    expect(cloneResultNotice({ created: [made('Early'), made('Late')], skipped: [], generated_blocks: 16 }, 'Studio A'))
      .toBe('Copied 2 templates from Studio A. 16 empty shifts added over the next 8 weeks.')
  })

  it('names each skip reason once', () => {
    expect(cloneResultNotice({
      created: [made('Early')],
      skipped: [
        { source_id: 's2', name: 'Late', reason: 'name_exists' },
        { source_id: 's3', name: 'Mid', reason: 'name_exists' },
        { source_id: 's4', name: 'Old', reason: 'inactive' },
      ],
      generated_blocks: 0,
    }, 'Studio A')).toBe('Copied 1 template from Studio A. 3 skipped: a template with this name is already here; deactivated at the other studio.')
  })

  it('says so when nothing was copied', () => {
    expect(cloneResultNotice({ created: [], skipped: [], generated_blocks: 0 }, 'Studio A')).toBe('Nothing was copied from Studio A.')
    expect(cloneResultNotice(undefined)).toBe('Nothing was copied from the other studio.')
  })
})
