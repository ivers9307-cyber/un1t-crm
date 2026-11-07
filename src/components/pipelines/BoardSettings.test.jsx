// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import BoardSettings, { REPLACE_CONFIRM, SWITCH_OFF_NOTE, LEGACY_NOTICE } from './BoardSettings.jsx'
import { LEGACY_BOARD_ERROR } from '@/lib/pipeline-boards'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const ok = (data) => json(200, { success: true, data })

const BOARD = {
  id: 'b1',
  key: 'o_spring',
  name: 'Spring',
  board_type: 'offer',
  recipe_key: 'paid_trial_offer',
  enabled: false,
  baseline_at: null,
  priority: 50,
  config: {
    entry: { type: 'trial_purchase', match: 'plan_code', values: ['RESET39'] },
    stages: [
      { role: 'new', slug: 'o_spring_new', name: 'New Leads' },
      { role: 'first_class', slug: 'o_spring_first_class', name: '1st Class' },
      { role: 'checkpoint', slug: 'o_spring_day_7', name: 'Day 7', day: 7 },
    ],
    duration_days: 14,
    quiet_days: 60,
    converted_window_days: 60,
  },
  stages: [
    { id: 's1', slug: 'o_spring_new', name: 'New Leads', stage_role: 'new', role_config: {}, display_order: 900, deal_count: 0 },
    { id: 's2', slug: 'o_spring_first_class', name: '1st Class', stage_role: 'first_class', role_config: {}, display_order: 901, deal_count: 0 },
    { id: 's3', slug: 'o_spring_day_7', name: 'Day 7', stage_role: 'checkpoint', role_config: { day: 7 }, display_order: 902, deal_count: 0 },
  ],
  followups: [
    { id: 'f1', stage_id: 's2', pack_key: 'after_first_class', state: 'live', version: 1, body_text: 'Hi {{1}}, how was your first class? UN1T Stillorgan', body_texts: { main: 'Hi {{1}}, how was your first class? UN1T Stillorgan' } },
  ],
}

// Routes the page calls, by URL and method; anything else fails the test.
function stubApi({ board = BOARD, canEdit = true, canEditWording = true, patch, put } = {}) {
  const fetchMock = vi.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET'
    if (url === '/api/pipelines/b1' && method === 'GET') return ok({ board, can_edit: canEdit, can_edit_wording: canEditWording })
    if (url === '/api/pipelines/b1' && method === 'PATCH') return patch ? patch(JSON.parse(opts.body)) : ok({ board })
    if (String(url).startsWith('/api/locations/loc1/pipeline-entry-options')) return ok({ options: [{ value: 'RESET39', label: '14 Day Reset' }] })
    if (String(url).startsWith('/api/pipelines/b1/followups/') && method === 'PUT') return put ? put(JSON.parse(opts.body)) : ok({ followup: {} })
    throw new Error(`unexpected ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const renderPage = () => render(<BoardSettings boardId="b1" locationId="loc1" studioName="UN1T Stillorgan" />)
const calls = (fetchMock, method) => fetchMock.mock.calls.filter(([, o]) => (o?.method || 'GET') === method)

describe('BoardSettings', () => {
  it('structureReadOnlyWhileOn', async () => {
    stubApi({ board: { ...BOARD, enabled: true, baseline_at: '2026-11-06T00:00:00Z' } })
    renderPage()
    await screen.findByLabelText(/^Board name/)
    // Who enters, Stages, Timings and Priority each say why.
    expect(screen.getAllByText(new RegExp(SWITCH_OFF_NOTE.replace('.', '\\.'))).length).toBe(4)
    expect(screen.getByLabelText('Priority').disabled).toBe(true)
    expect(screen.getByLabelText('Offer length in days').disabled).toBe(true)
    expect(screen.getByLabelText('Use the 1st Class stage').disabled).toBe(true)
    const entry = await screen.findByRole('checkbox', { name: /14 Day Reset/ })
    expect(entry.disabled).toBe(true)
    // Wording changes any time.
    expect(screen.getByLabelText(/^Board name/).disabled).toBe(false)
    expect(screen.getByLabelText('Offer name').disabled).toBe(false)
    expect(screen.getByLabelText('Name for the 1st Class stage').disabled).toBe(false)
    expect(screen.getByLabelText('Notes for Mia').disabled).toBe(false)
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Check who would enter' })).toBeNull()
  })

  it('an off board edits its structure and offers the launch panel', async () => {
    stubApi()
    renderPage()
    await screen.findByLabelText(/^Board name/)
    expect(screen.queryByText(SWITCH_OFF_NOTE)).toBeNull()
    expect(screen.getByLabelText('Priority').disabled).toBe(false)
    expect(screen.getByLabelText('Use the 1st Class stage').disabled).toBe(false)
    expect(screen.getByRole('button', { name: 'Check who would enter' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull()
  })

  it('managerSeesOnlyWordingActions', async () => {
    stubApi({ canEdit: false, canEditWording: true })
    renderPage()
    await screen.findByLabelText(/^Board name/)
    expect(screen.getByLabelText(/^Board name/).disabled).toBe(true)
    expect(screen.getByLabelText('Priority').disabled).toBe(true)
    expect(screen.getByLabelText('Name for the 1st Class stage').disabled).toBe(true)
    expect(screen.getByLabelText('Notes for Mia').disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check who would enter' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull()
    // The follow-up actions stay.
    const change = screen.getAllByRole('button', { name: 'Change wording' })
    expect(change.length).toBe(3)
    expect(change.every((b) => !b.disabled)).toBe(true)
    expect(screen.getByRole('button', { name: 'Switch off' }).disabled).toBe(false)
    expect(screen.getAllByRole('button', { name: 'Install' }).length).toBe(2)
  })

  it('a manager without template permissions gets no follow-up actions', async () => {
    stubApi({ canEdit: false, canEditWording: false })
    renderPage()
    await screen.findByLabelText(/^Board name/)
    expect(screen.queryByRole('button', { name: 'Change wording' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Switch off' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    // The current wording still shows.
    expect(screen.getByText('Hi {{1}}, how was your first class? UN1T Stillorgan')).toBeTruthy()
  })

  it('replaceAsksConfirmThenCallsReplace', async () => {
    const fetchMock = stubApi({ put: () => ok({ followup: { id: 'f1', state: 'awaiting_approval' } }) })
    renderPage()
    await screen.findByText('Hi {{1}}, how was your first class? UN1T Stillorgan')
    const changeButtons = screen.getAllByRole('button', { name: 'Change wording' })
    fireEvent.click(changeButtons[1]) // the 1st Class stage
    const box = screen.getByLabelText('After the first class: message')
    expect(box.value).toBe('Hi {{1}}, how was your first class? UN1T Stillorgan')
    fireEvent.change(box, { target: { value: 'Hi {{1}}, great to see you at {studio}. {signer}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save wording' }))
    expect(screen.getByText(REPLACE_CONFIRM)).toBeTruthy()
    expect(REPLACE_CONFIRM).toBe('The current message stops now. The new wording starts once Meta approves it, usually within a few hours.')
    expect(calls(fetchMock, 'PUT')).toHaveLength(0)
    fireEvent.click(screen.getAllByRole('button', { name: 'Change wording' }).pop())
    await waitFor(() => expect(calls(fetchMock, 'PUT')).toHaveLength(1))
    const [url, opts] = calls(fetchMock, 'PUT')[0]
    expect(url).toBe('/api/pipelines/b1/followups/s2')
    expect(JSON.parse(opts.body)).toEqual({
      action: 'replace',
      pack_key: 'after_first_class',
      bodies: { main: 'Hi {{1}}, great to see you at {studio}. {signer}' },
    })
    await waitFor(() => expect(screen.queryByText(REPLACE_CONFIRM)).toBeNull())
  })

  it('a stage with no follow-up installs without a confirm and shows the publish error', async () => {
    const fetchMock = stubApi({ put: () => ok({ followup: { id: 'f2', state: 'awaiting_approval' }, publish_error: 'Could not publish just now.' }) })
    renderPage()
    await screen.findByLabelText(/^Board name/)
    fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[0])
    await waitFor(() => expect(calls(fetchMock, 'PUT')).toHaveLength(1))
    expect(JSON.parse(calls(fetchMock, 'PUT')[0][1].body)).toEqual({ action: 'install', pack_key: 'book_first_class' })
    expect(await screen.findByText('Could not publish just now.')).toBeTruthy()
    expect(screen.queryByText(REPLACE_CONFIRM)).toBeNull()
  })

  it('switch off calls off', async () => {
    const fetchMock = stubApi()
    renderPage()
    await screen.findByLabelText(/^Board name/)
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }))
    await waitFor(() => expect(calls(fetchMock, 'PUT')).toHaveLength(1))
    expect(JSON.parse(calls(fetchMock, 'PUT')[0][1].body)).toEqual({ action: 'off', pack_key: 'after_first_class' })
  })

  it('patch409MessageShown', async () => {
    const message = 'Switch the board off before changing its entry rule, stages or timings.'
    let sent = null
    stubApi({ patch: (body) => { sent = body; return json(409, { success: false, error: message, code: 'switch_off_first' }) } })
    renderPage()
    const name = await screen.findByLabelText(/^Board name/)
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true)
    fireEvent.change(name, { target: { value: 'Spring reset' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(message)).toBeTruthy()
    // Only what changed is sent.
    expect(sent).toEqual({ name: 'Spring reset' })
  })

  it('a structural change sends the whole config, keeping the stored timings', async () => {
    let sent = null
    stubApi({ patch: (body) => { sent = body; return ok({ board: BOARD }) } })
    renderPage()
    await screen.findByLabelText(/^Board name/)
    fireEvent.change(screen.getByLabelText('Offer length in days'), { target: { value: '21' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(sent).not.toBeNull())
    expect(Object.keys(sent)).toEqual(['config'])
    expect(sent.config).toMatchObject({ duration_days: 21, quiet_days: 60, converted_window_days: 60 })
    expect(sent.config.stages.map((s) => s.role)).toEqual(['new', 'first_class', 'checkpoint'])
  })

  it('legacyBoardIdShowsReadOnlyNotice', async () => {
    stubApi({ board: { ...BOARD, board_type: null, recipe_key: null, config: null, followups: [] } })
    renderPage()
    expect(await screen.findByText(LEGACY_NOTICE)).toBeTruthy()
    expect(LEGACY_NOTICE).toBe(LEGACY_BOARD_ERROR)
    expect(screen.queryByLabelText(/^Board name/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it("another studio's board is the route's 404", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { success: false, error: 'Not found' })))
    renderPage()
    expect(await screen.findByText("This board doesn't exist, or it isn't at your studio.")).toBeTruthy()
  })
})
