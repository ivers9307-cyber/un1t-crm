// @vitest-environment jsdom
//
// COMMSFIX.D.3 — three ways the campaign editor destroyed operator work:
//   (a) editorMode always initialised to 'visual' (the ternary at :67 was
//       `designJson ? 'visual' : 'visual'`), so a code-authored draft
//       (html_content, design_json null) opened into a BLANK Unlayer canvas
//       and Save overwrote the stored HTML with an empty scaffold.
//       Audit 2026-08-09 composer-ux, CONFIRMED high.
//   (b) the schedule input seeded from `.toISOString()` — a UTC wall clock
//       rendered into a local-time input, so re-confirming a 10:00 Dublin
//       send silently moved it to 09:00, an hour earlier every round trip.
//   (c) delete navigated to /email/campaigns, which has no page — a 404.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const push = vi.fn()
const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }))
vi.mock('./AudienceBuilder', () => ({ default: () => <div data-testid="audience-builder" /> }))

let deleteError = null
vi.mock('@/lib/supabase', () => ({
  createBrowserClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
      update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'camp-1' }, error: null }) }) }) }),
      delete: () => ({ eq: async () => ({ error: deleteError }) }),
    }),
  }),
}))

import CampaignEditor from './CampaignEditor.jsx'

const BASE = {
  id: 'camp-1',
  name: 'Weekend offer',
  subject: 'Last chance',
  status: 'draft',
  location_id: 'loc-1',
  audience_filter: { logic: 'and', filters: [] },
}

const CODE_HTML = '<html><body><h1>UN1T branded email</h1></body></html>'

beforeEach(() => {
  vi.clearAllMocks()
  deleteError = null
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, audience_count: 10 }) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderEditor(overrides = {}) {
  return render(<CampaignEditor campaign={{ ...BASE, ...overrides }} locationId="loc-1" userId="user-1" />)
}

describe('CampaignEditor — a code-authored draft opens in code mode', () => {
  it('opens the HTML Code tab with the stored html when there is no design_json', () => {
    renderEditor({ html_content: CODE_HTML, design_json: null })
    const area = screen.getByPlaceholderText(/Paste or write your HTML email here/i)
    expect(area.value).toBe(CODE_HTML)
  })

  it('opens in visual mode when the draft has a design_json', () => {
    renderEditor({ html_content: CODE_HTML, design_json: { body: { rows: [] } } })
    expect(screen.queryByPlaceholderText(/Paste or write your HTML email here/i)).toBeNull()
  })

  it('opens in visual mode for a brand-new empty draft', () => {
    renderEditor({ html_content: null, design_json: null })
    expect(screen.queryByPlaceholderText(/Paste or write your HTML email here/i)).toBeNull()
  })
})

describe('CampaignEditor — deleting a draft lands somewhere real', () => {
  it('navigates to the sends list, not the 404 /email/campaigns', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    renderEditor({ html_content: CODE_HTML })
    fireEvent.click(screen.getByTitle('Delete this draft'))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/communications/sent'))
  })
})
