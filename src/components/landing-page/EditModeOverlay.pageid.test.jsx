// @vitest-environment jsdom
//
// PAGES.1 (Task 18b): a `state` message carrying pageId reaches every upload
// site as pageId: the block renderer and the site header (logo swapper). A
// state message without it leaves pageId null (legacy /welcome).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

const seen = vi.hoisted(() => ({ blocks: [], header: [] }))
vi.mock('./BlockRenderers', () => ({
  default: (p) => { seen.blocks.push({ id: p.block.id, pageId: p.pageId, locationId: p.locationId }); return null },
  SiteHeader: (p) => { seen.header.push({ pageId: p.pageId, locationId: p.locationId }); return null },
  SiteFooter: () => null,
}))

import EditModeOverlay from './EditModeOverlay.jsx'

const blocks = [{ id: 'h', type: 'hero' }, { id: 'g', type: 'gallery' }]
const last = (arr) => arr[arr.length - 1]
const send = async (data) => {
  await act(async () => { window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data: { namespace: 'lp-editor', type: 'state', ...data } })) })
}

beforeEach(() => { seen.blocks = []; seen.header = [] })
afterEach(() => cleanup())

describe('EditModeOverlay pageId', () => {
  it('a state message with pageId (and no location) reaches the blocks and the header as pageId', async () => {
    render(<EditModeOverlay initialBlocks={blocks} />)
    expect(last(seen.blocks)).toMatchObject({ pageId: null, locationId: null })
    await send({ blocks, locationId: null, pageId: 'p-1' })
    expect(seen.blocks.slice(-2)).toEqual([
      { id: 'h', pageId: 'p-1', locationId: null },
      { id: 'g', pageId: 'p-1', locationId: null },
    ])
    expect(last(seen.header)).toEqual({ pageId: 'p-1', locationId: null })
  })

  it('a legacy state message (locationId only) leaves pageId null', async () => {
    render(<EditModeOverlay initialBlocks={blocks} />)
    await send({ blocks, locationId: 'loc-1' })
    expect(last(seen.blocks)).toMatchObject({ pageId: null, locationId: 'loc-1' })
    expect(last(seen.header)).toEqual({ pageId: null, locationId: 'loc-1' })
  })
})
