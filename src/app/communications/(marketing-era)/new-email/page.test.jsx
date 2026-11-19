// @vitest-environment jsdom
//
// QUICKEMAIL-RETIRE.1 — the Segments page's "Email these" links land on
// /communications/new-email. A tag seeds one clause; a saved segment is read
// AT the active studio, and only for someone who may read segments there.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: () => null }))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: () => true }))
let canReadSegments = true
vi.mock('@/lib/segment-access', () => ({ canReadSegmentsAt: () => canReadSegments }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/email-templates-for-agents', () => ({ listMarketingTemplates: async () => ({ templates: [] }) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }) }))
vi.mock('@/components/communications/NewEmailPicker', () => ({
  default: (props) => <div data-testid="picker-props">{JSON.stringify(props)}</div>,
}))

import NewEmailPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const HERE = 'a0000000-0000-0000-0000-000000000001'
const THERE = 'b0000000-0000-0000-0000-000000000002'
const SEG = 'c0000000-0000-0000-0000-000000000003'
const FOREIGN_SEG = 'd0000000-0000-0000-0000-000000000004'
const FILTER = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }

let db
beforeEach(() => {
  canReadSegments = true
  getCurrentUser.mockResolvedValue({ id: 'u1', activeLocation: { id: HERE, name: 'Studio' } })
  db = createFakeDb({
    tables: {
      contact_segments: [
        { id: SEG, location_id: HERE, name: 'Members', filter: FILTER },
        { id: FOREIGN_SEG, location_id: THERE, name: 'Theirs', filter: FILTER },
      ],
    },
  })
  createServerClient.mockReturnValue(db)
})
afterEach(cleanup)

async function audienceFor(searchParams) {
  render(await NewEmailPage({ searchParams: Promise.resolve(searchParams) }))
  return JSON.parse(screen.getByTestId('picker-props').textContent).audience
}

describe('/communications/new-email starting audience', () => {
  it('none without a link', async () => {
    expect(await audienceFor({})).toBeNull()
  })

  it('a tag link seeds one tag clause', async () => {
    expect(await audienceFor({ segment: 'race-2026' })).toEqual({
      label: 'Tag: race-2026',
      filter: { logic: 'and', filters: [{ field: 'tag', op: 'eq', value: 'race-2026' }] },
    })
  })

  it("a saved segment at this studio applies its filter", async () => {
    expect(await audienceFor({ segment_id: SEG })).toEqual({ label: 'Members', filter: FILTER })
  })

  it("another studio's segment is not applied", async () => {
    expect(await audienceFor({ segment_id: FOREIGN_SEG })).toEqual({ missing: true })
  })

  it('a segment is not read for someone who may not read segments', async () => {
    canReadSegments = false
    expect(await audienceFor({ segment_id: SEG })).toEqual({ missing: true })
    expect(db.calls.some((c) => c.table === 'contact_segments')).toBe(false)
  })

  it('a malformed id is not looked up', async () => {
    expect(await audienceFor({ segment_id: 'not-a-uuid' })).toEqual({ missing: true })
  })
})
