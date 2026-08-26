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
let editSeq = 0
let builderProps = null
vi.mock('./AudienceBuilder', () => ({
  // FILTER-P1.6 — the stand-in exposes an onChange trigger, because the
  // double-count bug only appears on an EDIT: the old code called
  // refreshAudienceCount() from onChange AND had a useEffect on the same
  // state, so one edit produced two POSTs.
  default: (props) => {
    builderProps = props
    return (
      <div data-testid="audience-builder">
        <button type="button" onClick={() => props.onChange({
          logic: 'and', filters: [{ field: 'gender', op: 'eq', value: `v${++editSeq}` }],
        })}>mock edit filter</button>
      </div>
    )
  },
}))

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
  builderProps = null
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

// FILTER-C.3 — no guessed starting row. FILTER-B.3 removed the seeded
// `Stage = member` from the WhatsApp and SMS editors on the argument that an
// audience the operator did not choose is a trap: it renders as an ordinary
// row, indistinguishable from a deliberate filter, and quietly excludes every
// lead from a campaign built by someone who never touched the builder.
// The campaign editor and the unified composer were the last two seeding it.
describe('CampaignEditor — "Add filter" seeds nothing', () => {
  async function openAudienceTab(overrides = {}) {
    renderEditor(overrides)
    fireEvent.click(screen.getByRole('button', { name: /audience/i }))
    await screen.findByTestId('audience-builder')
  }

  it('passes no defaultFilterRow to the audience builder', async () => {
    await openAudienceTab()
    expect(builderProps).toBeTruthy()
    expect(builderProps.defaultFilterRow ?? null).toBeNull()
  })

  it('opens an empty draft with an empty filter, not a one-row guess', async () => {
    await openAudienceTab({ audience_filter: null })
    expect(builderProps.filter?.filters ?? []).toHaveLength(0)
  })
})

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

// UNLAYER-H.2 — the visual mount has to be able to SIZE Unlayer's iframe.
// The embed sizes that iframe `height: 100%`, so the mount needs a height a
// percentage can resolve against. UNLAYER-H.1 declared `height: 75vh` on it but
// left `className="flex-1"` in place, and `flex: 1 1 0%` REPLACES `height` as
// the flex base size — so the declared height was never consulted. The used
// height came out of flex layout inside a column whose own height is indefinite
// (`h-full` on top of the plain-div chain DESIGN-2 left behind when it dropped
// the editor's `h-screen`), and a percentage against an indefinite height
// resolves to auto, so the iframe fell back to the 150px HTML default: a
// squashed tool panel over a dead dark block.
//
// Measured against the live embed with the app's exact init config — same 600px
// mount either way, iframe 150px WITH `flex-1` and 600px WITHOUT it. jsdom does
// no layout, so this pins the DOM contract that measurement proved, not pixels.
describe('CampaignEditor — the visual mount can size the Unlayer iframe', () => {
  function visualMount() {
    const { container } = renderEditor({ html_content: null, design_json: { body: { rows: [] } } })
    const el = container.querySelector('#unlayer-editor')
    expect(el).not.toBeNull()
    return el
  }

  it('declares a definite height on the mount', () => {
    const height = visualMount().style.height
    expect(height).toMatch(/^[0-9]/)
    expect(height).not.toBe('auto')
  })

  it('does not flex the mount, which would discard that height', () => {
    expect(visualMount().className).not.toMatch(/(^|\s)flex-1(\s|$)/)
  })
})

describe('CampaignEditor — the schedule input seeds in LOCAL time', () => {
  // Run this file under TZ=Europe/Dublin and TZ=America/New_York; the
  // assertion is offset-derived so it holds in both.
  const SCHEDULED = '2026-08-20T09:00:00.000Z'   // 10:00 Dublin (IST)

  function expectedLocal(iso) {
    const off = new Date(iso).getTimezoneOffset()
    return new Date(Date.parse(iso) - off * 60_000).toISOString().slice(0, 16)
  }

  function openScheduleTray() {
    fireEvent.click(screen.getByTitle('Send at a later date and time'))
    return document.querySelector('input[type="datetime-local"]')
  }

  it('shows the operator wall clock, not the UTC one', () => {
    renderEditor({ status: 'draft', scheduled_at: SCHEDULED, html_content: CODE_HTML })
    expect(openScheduleTray().value).toBe(expectedLocal(SCHEDULED))
  })

  it('does not shift the send when the operator re-confirms without touching the time', () => {
    renderEditor({ status: 'draft', scheduled_at: SCHEDULED, html_content: CODE_HTML })
    // handleSchedule reinterprets the input value as local time; the seeded
    // value must therefore round-trip back to the SAME instant.
    expect(new Date(openScheduleTray().value).toISOString()).toBe(SCHEDULED)
  })

  it('leaves the input empty when nothing is scheduled', () => {
    renderEditor({ status: 'draft', html_content: CODE_HTML })
    expect(openScheduleTray().value).toBe('')
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

// ── FILTER-P1.6 — counts that don't lie ──────────────────────────────
//
// (a) The banner claimed the audience was "already filtered for marketing
//     opt-in, valid email, non-ClassPass". There is NO ClassPass exclusion
//     anywhere in the send path, and "valid email" is vacuous (contacts.email
//     is NOT NULL). buildAudienceQueryAsync gates on: this location, the
//     per-location consent flag for the stream, email_status not
//     bounced/complained, and (marketing only) not inactivity-suppressed.
// (b) The count fired from BOTH the builder's onChange and a useEffect on the
//     same state — two POSTs per keystroke, no debounce, no abort, no
//     sequence guard, so a slow earlier response could overwrite a later one
//     and the Send confirm dialog then quoted the stale number.
describe('CampaignEditor — the audience banner states the real gates (P1.6a)', () => {
  async function bannerText(overrides = {}) {
    renderEditor(overrides)
    fireEvent.click(screen.getByRole('button', { name: /audience/i }))
    return await screen.findByText(/already filtered for/i)
  }

  it('does not claim a ClassPass exclusion that the send path does not apply', async () => {
    const el = await bannerText()
    expect(el.textContent).not.toMatch(/classpass/i)
  })

  it('does not claim a vacuous "valid email" check', async () => {
    const el = await bannerText()
    expect(el.textContent).not.toMatch(/valid email/i)
  })

  it('names the gates that are really applied for a marketing send', async () => {
    const el = await bannerText()
    expect(el.textContent).toMatch(/marketing opt-in/i)
    expect(el.textContent).toMatch(/bounce/i)
    expect(el.textContent).toMatch(/complaint/i)
    expect(el.textContent).toMatch(/suppress/i)
  })
})

describe('CampaignEditor — the count is debounced and last-request-wins (P1.6b)', () => {
  beforeEach(() => { vi.useFakeTimers(); editSeq = 0 })
  afterEach(() => { vi.useRealTimers() })

  const previewCalls = () => fetch.mock.calls.filter(([url]) => String(url).includes('/preview'))

  it('fires ONE preview POST per edit, not two', async () => {
    renderEditor()
    await vi.advanceTimersByTimeAsync(1000)
    const before = previewCalls().length
    fireEvent.click(screen.getByRole('button', { name: /audience/i }))
    await vi.advanceTimersByTimeAsync(0)   // switchTab awaits before setTab
    fireEvent.click(screen.getByRole('button', { name: /mock edit filter/i }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(previewCalls().length - before).toBe(1)
  })

  it('debounces a burst of edits into a single POST', async () => {
    renderEditor()
    await vi.advanceTimersByTimeAsync(1000)
    const before = previewCalls().length
    fireEvent.click(screen.getByRole('button', { name: /audience/i }))
    await vi.advanceTimersByTimeAsync(0)   // switchTab awaits before setTab
    const edit = screen.getByRole('button', { name: /mock edit filter/i })
    for (let i = 0; i < 5; i++) {
      fireEvent.click(edit)
      await vi.advanceTimersByTimeAsync(50)
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(previewCalls().length - before).toBe(1)
  })

  it('lets the LAST response win when an earlier one resolves late', async () => {
    // The first in-flight POST resolves SLOWLY with a stale 999; the later one
    // resolves fast with the real 10. The banner must never settle on 999 —
    // the Send confirm dialog quotes this number verbatim.
    let call = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      call += 1
      const n = call === 1 ? 999 : 10
      const delay = call === 1 ? 3000 : 0
      return new Promise(resolve => setTimeout(
        () => resolve({ ok: true, json: async () => ({ success: true, audience_count: n }) }),
        delay,
      ))
    }))
    renderEditor()
    fireEvent.click(screen.getByRole('button', { name: /audience/i }))
    await vi.advanceTimersByTimeAsync(600)          // first POST in flight (slow)
    fireEvent.click(screen.getByRole('button', { name: /mock edit filter/i }))
    await vi.advanceTimersByTimeAsync(600)          // second POST fires + resolves 10
    expect(screen.getByTestId('audience-count').textContent).toBe('10')
    await vi.advanceTimersByTimeAsync(5000)         // the stale 999 lands late
    expect(screen.getByTestId('audience-count').textContent).toBe('10')
  })
})

// CAMPHIST.1 — the editor is the component that actually wrote over sent
// campaigns, and it did it OUTSIDE the API: `handleSave` calls
// `db.from('campaigns').update(payload).eq('id', campaignId)` on the browser
// Supabase client. So the 409 on PUT /api/campaigns/[id] never applied, and
// the mig 014 RLS policy (FOR ALL, no status predicate) allowed the write.
//
// The page no longer routes a sent campaign here, but the editor is reached
// from two other places (UnifiedSendComposer's "open full editor", and
// CampaignDetail's draft redirect), so the refusal belongs here too.
describe('CampaignEditor — a campaign whose content is locked is read-only', () => {
  it('shows the real status, not a hard-coded "Draft" pill', () => {
    renderEditor({ status: 'sent' })
    expect(screen.getByTestId('campaign-status-pill').textContent).toMatch(/sent/i)
  })

  it('still shows "Draft" for an actual draft', () => {
    renderEditor({ status: 'draft' })
    expect(screen.getByTestId('campaign-status-pill').textContent).toMatch(/draft/i)
  })

  it.each(['sent', 'sending', 'queued', 'cancelled', 'failed'])(
    'offers no Save button for a %s campaign',
    (status) => {
      renderEditor({ status })
      expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull()
    },
  )

  it('explains why, and points at duplicating', () => {
    renderEditor({ status: 'sent' })
    const notice = screen.getByTestId('campaign-locked-notice')
    expect(notice.textContent.toLowerCase()).toContain('duplicate')
  })

  it('keeps Save for a draft', () => {
    renderEditor({ status: 'draft' })
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeTruthy()
  })

  it('keeps Save for a scheduled campaign', () => {
    renderEditor({ status: 'scheduled' })
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeTruthy()
  })
})
