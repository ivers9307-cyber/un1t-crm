import { describe, it, expect } from 'vitest'
import { toBoardDeal, pipelineContactFields, PIPELINE_PAGE_SIZE } from './pipeline-board.js'

describe('toBoardDeal', () => {
  it('strips recent_bookings from the outgoing payload', () => {
    const out = toBoardDeal({
      id: 'd1', stage_id: 's1', title: 't',
      contacts: { id: 'c1', name: 'Ann', pipeline_stage_slug: 'member', recent_bookings: [{ start: 'x' }] },
    })
    expect(out.contacts.recent_bookings).toBeUndefined()
    expect(out.contacts.id).toBe('c1')
  })

  it('null next_class_at for non-badge (off-funnel) stages', () => {
    const out = toBoardDeal({ id: 'd', contacts: { id: 'c', pipeline_stage_slug: 'dormant', recent_bookings: [] } })
    expect(out.contacts.next_class_at).toBeNull()
  })

  it('derives next_class_at only for the four funnel badge stages', () => {
    for (const slug of ['new_lead', 'first_class', 'second_class', 'trial_done']) {
      const out = toBoardDeal({ id: 'd', contacts: { id: 'c', pipeline_stage_slug: slug, recent_bookings: null } })
      // Present as a key (value comes from nextBookedClass; null with no bookings).
      expect('next_class_at' in out.contacts).toBe(true)
    }
    const off = toBoardDeal({ id: 'd', contacts: { id: 'c', pipeline_stage_slug: 'converted', recent_bookings: null } })
    expect(off.contacts.next_class_at).toBeNull()
  })

  it('tolerates a missing contacts object', () => {
    const out = toBoardDeal({ id: 'd', stage_id: 's' })
    expect(out.contacts.next_class_at).toBeNull()
  })
})

describe('pipelineContactFields', () => {
  it('includes recent_bookings only on the funnel (non-dormant) view', () => {
    expect(pipelineContactFields('active')).toContain('recent_bookings')
    expect(pipelineContactFields('dormant')).not.toContain('recent_bookings')
  })
  it('page size is a sane positive number', () => {
    expect(PIPELINE_PAGE_SIZE).toBeGreaterThan(0)
  })
})
