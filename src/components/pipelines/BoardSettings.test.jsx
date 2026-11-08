// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import BoardSettings, {
  REPLACE_CONFIRM, SWITCH_OFF_NOTE, LEGACY_NOTICE, WORDING_UNKNOWN_NOTE, REJECTED_NOTE, TURN_OFF_CONFIRM,
  OLD_WORDING_UNKNOWN_NOTE, FILLED_IN_NOTE, START_FROM_STANDARD, OWNER_ONLY_INSTALL_NOTE, OWNER_ONLY_REJECTED_NOTE, FOLLOWUP_OFF_CONFIRM, staleWordingNotice,
} from './BoardSettings.jsx'
import { LEGACY_BOARD_ERROR } from '@/lib/pipeline-boards'
import { RECIPES } from '@shared/pipelines/recipes.js'
import { NO_WHATSAPP_NOTICE } from './NoWhatsappNotice'

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
    { id: 'f1', stage_id: 's2', pack_key: 'after_first_class', state: 'live', version: 1, whatsapp_template_id: 't1', body_text: 'Hi {{1}}, how was your first class? UN1T Stillorgan', body_texts: { main: 'Hi {{1}}, how was your first class? UN1T Stillorgan' } },
  ],
}

// Routes the page calls, by URL and method; anything else fails the test.
function stubApi({ board = BOARD, canEdit = true, canEditWording = true, patch, put } = {}) {
  const fetchMock = vi.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET'
    if (url === '/api/pipelines/b1' && method === 'GET') return ok({ board, can_edit: canEdit, can_edit_wording: canEditWording })
    if (url === '/api/pipelines/b1' && method === 'PATCH') return patch ? patch(JSON.parse(opts.body)) : ok({ board })
    if (String(url).startsWith('/api/locations/loc1/pipeline-entry-options')) return ok({ options: [{ value: 'RESET39', label: '14 Day Reset' }] })
    if (url === '/api/pipelines/b1/report') return json(500, { success: false, error: 'no report in this test' })
    if (url === '/api/pipelines/b1/disable' && method === 'POST') return ok({ board: { ...board, enabled: false } })
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
    // RAILS.1 — installing or switching off is owner work.
    expect(screen.queryByRole('button', { name: 'Switch off' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('a manager opening the editor on a stage with no follow-up is told only an owner can install it', async () => {
    const fetchMock = stubApi({ canEdit: false, canEditWording: true })
    renderPage()
    await screen.findByLabelText(/^Board name/)
    // s1 (New Leads) has no row.
    fireEvent.click(screen.getAllByRole('button', { name: 'Change wording' })[0])
    expect(await screen.findByText(OWNER_ONLY_INSTALL_NOTE)).toBeTruthy()
    const save = screen.getByRole('button', { name: 'Save wording' })
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(calls(fetchMock, 'PUT').length).toBe(0)
  })

  it('a manager changing a live follow-up sees no owner-only note', async () => {
    stubApi({ canEdit: false, canEditWording: true })
    renderPage()
    await screen.findByLabelText(/^Board name/)
    // s2 (1st Class) is live.
    fireEvent.click(screen.getAllByRole('button', { name: 'Change wording' })[1])
    await screen.findByRole('button', { name: 'Save wording' })
    expect(screen.queryByText(OWNER_ONLY_INSTALL_NOTE)).toBeNull()
  })

  it('a live row whose template WhatsApp paused says so, and keeps Switch off', async () => {
    stubApi({ board: { ...BOARD, followups: [{ ...BOARD.followups[0], health: 'template_paused' }] } })
    renderPage()
    await screen.findByLabelText(/^Board name/)
    const chips = screen.getAllByText('Paused by WhatsApp')
    expect(chips.length).toBeGreaterThan(0)
    chips.forEach((c) => expect(c.className).toContain('text-amber-700'))
    expect(screen.queryByText('Live')).toBeNull()
    expect(screen.getByRole('button', { name: 'Switch off' })).toBeTruthy()
  })
  it('an owner sees Switch off and Install', async () => {
    stubApi()
    renderPage()
    await screen.findByLabelText(/^Board name/)
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

  it('switch off asks first, then calls off on Confirm', async () => {
    const fetchMock = stubApi()
    renderPage()
    await screen.findByLabelText(/^Board name/)
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }))
    expect(screen.getByText('Switch off this follow-up')).toBeTruthy()
    expect(screen.getByText(FOLLOWUP_OFF_CONFIRM)).toBeTruthy()
    expect(FOLLOWUP_OFF_CONFIRM).toBe('This stops the follow-up for everyone now, including people part-way through it, and archives its sequence. Switching it on again sends the message to WhatsApp for approval again, which can take hours.')
    expect(calls(fetchMock, 'PUT')).toHaveLength(0)
    fireEvent.click(screen.getAllByRole('button', { name: 'Switch off' }).pop())
    await waitFor(() => expect(calls(fetchMock, 'PUT')).toHaveLength(1))
    expect(JSON.parse(calls(fetchMock, 'PUT')[0][1].body)).toEqual({ action: 'off', pack_key: 'after_first_class' })
    await waitFor(() => expect(screen.queryByText(FOLLOWUP_OFF_CONFIRM)).toBeNull())
  })

  it('Cancel on the switch off confirm posts nothing', async () => {
    const fetchMock = stubApi()
    renderPage()
    await screen.findByLabelText(/^Board name/)
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText(FOLLOWUP_OFF_CONFIRM)).toBeNull())
    expect(calls(fetchMock, 'PUT')).toHaveLength(0)
  })

  it('a 409 on switch off closes the confirm and shows the route error', async () => {
    stubApi({ put: () => json(409, { success: false, error: 'Switch the board off first.' }) })
    renderPage()
    await screen.findByLabelText(/^Board name/)
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Switch off' }).pop())
    expect(await screen.findByText('Switch the board off first.')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(FOLLOWUP_OFF_CONFIRM)).toBeNull())
  })

  it('a rejected note tells a non-owner to ask an owner', async () => {
    const rejected = { id: 'f2', stage_id: 's1', pack_key: 'book_first_class', state: 'rejected', version: 1, whatsapp_template_id: 't2', body_text: 'Hi {{1}}, book now.', body_texts: { main: 'Hi {{1}}, book now.' } }
    stubApi({ canEdit: false, board: { ...BOARD, followups: [rejected, ...BOARD.followups] } })
    renderPage()
    expect(await screen.findByText(OWNER_ONLY_REJECTED_NOTE)).toBeTruthy()
    expect(OWNER_ONLY_REJECTED_NOTE).toBe('Meta rejected this wording. Ask an owner to install it again.')
    expect(screen.queryByText(REJECTED_NOTE)).toBeNull()
  })

  it('an unreadable wording read blocks Change wording but not Switch off', async () => {
    stubApi({ board: { ...BOARD, wording_unread: true, followups: [{ ...BOARD.followups[0], body_text: undefined, body_texts: undefined }] } })
    renderPage()
    await screen.findByLabelText(/^Board name/)
    const change = screen.getAllByRole('button', { name: 'Change wording' })
    expect(change[1].disabled).toBe(true)  // 1st Class: a live follow-up
    expect(change[0].disabled).toBe(false) // New Leads: nothing installed, nothing to lose
    expect(screen.getByText(WORDING_UNKNOWN_NOTE)).toBeTruthy()
    expect(WORDING_UNKNOWN_NOTE).toBe("The current wording couldn't be read. Try again later before changing it.")
    expect(screen.getByRole('button', { name: 'Switch off' }).disabled).toBe(false)
  })

  it('an unreadable health read says so beside the follow-ups', async () => {
    stubApi({ board: { ...BOARD, health_unread: true } })
    renderPage()
    await screen.findByLabelText(/^Board name/)
    const line = screen.getByText('Could not check whether WhatsApp has paused or rejected a follow-up just now. Reload the page to try again.')
    expect(line.className).toContain('text-amber-700')
  })

  it("one message's wording not found blocks Change wording for that follow-up", async () => {
    const halfway = { id: 'f3', stage_id: 's3', pack_key: 'halfway', state: 'live', version: 1, whatsapp_template_id: 't3', body_text: 'Hi {{1}}, halfway.', body_texts: { main: 'Hi {{1}}, halfway.' }, wording_missing: ['nudge'] }
    stubApi({ board: { ...BOARD, followups: [...BOARD.followups, halfway] } })
    renderPage()
    await screen.findByText('Hi {{1}}, halfway.')
    const change = screen.getAllByRole('button', { name: 'Change wording' })
    expect(change[2].disabled).toBe(true)
    expect(change[1].disabled).toBe(false)
    expect(screen.getAllByText(WORDING_UNKNOWN_NOTE)).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Switch off' }).every((b) => !b.disabled)).toBe(true)
  })

  it('a switched-off follow-up with unreadable wording: Install is locked, Change wording starts from the standard wording and installs', async () => {
    const off = { id: 'f3', stage_id: 's3', pack_key: 'halfway', state: 'off', version: 2, whatsapp_template_id: 't3', body_text: 'Hi {{1}}, halfway.', body_texts: { main: 'Hi {{1}}, halfway.' }, wording_missing: ['nudge'] }
    const fetchMock = stubApi({ board: { ...BOARD, followups: [...BOARD.followups, off] } })
    renderPage()
    await screen.findByText('Hi {{1}}, halfway.')
    expect(screen.queryByText(WORDING_UNKNOWN_NOTE)).toBeNull()
    const change = screen.getAllByRole('button', { name: 'Change wording' })[2]
    expect(change.disabled).toBe(false)
    // Install would send standard or half-standard wording unseen: only
    // Change wording (with its note) goes in. New Leads (nothing installed) still installs.
    const install = screen.getAllByRole('button', { name: 'Install' })
    expect(install).toHaveLength(2)
    expect(install[0].disabled).toBe(false)
    expect(install[1].disabled).toBe(true)
    fireEvent.click(change)
    expect(screen.getByText(OLD_WORDING_UNKNOWN_NOTE)).toBeTruthy()
    expect(OLD_WORDING_UNKNOWN_NOTE).toBe("The old wording couldn't be read, so this starts from the standard wording.")
    const halfway = RECIPES.paid_trial_offer.packs.find((p) => p.key === 'halfway')
    expect(screen.getByLabelText('Halfway check-in: message').value).toBe(halfway.templates[0].body)
    fireEvent.change(screen.getByLabelText('Halfway check-in: message'), { target: { value: 'Hi {{1}}, halfway at {studio}. {signer}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save wording' }))
    expect(screen.queryByText(REPLACE_CONFIRM)).toBeNull()
    await waitFor(() => expect(calls(fetchMock, 'PUT')).toHaveLength(1))
    expect(JSON.parse(calls(fetchMock, 'PUT')[0][1].body)).toEqual({
      action: 'install', pack_key: 'halfway', bodies: { main: 'Hi {{1}}, halfway at {studio}. {signer}' },
    })
  })

  it('a switched-off follow-up when the whole wording read failed: Install is locked too', async () => {
    const off = { ...BOARD.followups[0], state: 'off', body_text: undefined, body_texts: undefined }
    stubApi({ board: { ...BOARD, wording_unread: true, followups: [off] } })
    renderPage()
    await screen.findByLabelText(/^Board name/)
    const install = screen.getAllByRole('button', { name: 'Install' })
    expect(install).toHaveLength(3)
    expect(install.map((b) => b.disabled)).toEqual([false, true, false])
    expect(screen.getAllByRole('button', { name: 'Change wording' })[1].disabled).toBe(false)
  })

  it('the name section says sent messages keep the values they were filled in with', async () => {
    stubApi()
    renderPage()
    await screen.findByLabelText(/^Board name/)
    expect(screen.getByText(FILLED_IN_NOTE)).toBeTruthy()
    expect(FILLED_IN_NOTE).toBe('These messages were filled in when they were sent to Meta. If you change the offer name, sign-off or offer length, change the wording of each message too.')
  })

  it('Start from the standard wording resets the boxes, previewed with the current offer name and length, and sends no override', async () => {
    const board = { ...BOARD, config: { ...BOARD.config, offer_name: 'Spring Reset', duration_days: 21 } }
    const fetchMock = stubApi({ board, put: () => ok({ followup: { id: 'f1', state: 'awaiting_approval' } }) })
    const { container } = renderPage()
    await screen.findByText('Hi {{1}}, how was your first class? UN1T Stillorgan')
    fireEvent.click(screen.getAllByRole('button', { name: 'Change wording' })[1]) // the 1st Class stage
    const box = screen.getByLabelText('After the first class: message')
    expect(box.value).toBe('Hi {{1}}, how was your first class? UN1T Stillorgan')
    const reset = screen.getByRole('button', { name: START_FROM_STANDARD })
    expect(reset.getAttribute('type')).toBe('button')
    fireEvent.click(reset)
    const standard = RECIPES.paid_trial_offer.packs.find((p) => p.key === 'after_first_class').templates[0].body
    expect(screen.getByLabelText('After the first class: message').value).toBe(standard)
    expect(container.textContent).toContain('first class of the Spring Reset at UN1T Stillorgan')
    expect(container.textContent).toContain('over the 21 days')
    fireEvent.click(screen.getByRole('button', { name: 'Save wording' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Change wording' }).pop()) // the live row: confirm the replace
    await waitFor(() => expect(calls(fetchMock, 'PUT')).toHaveLength(1))
    // The recipe's own wording: no override, so the server fills in today's values.
    expect(JSON.parse(calls(fetchMock, 'PUT')[0][1].body)).toEqual({ action: 'replace', pack_key: 'after_first_class' })
  })

  it('a save that changes the offer name, sign-off and length names the sending follow-ups that keep the old values', async () => {
    const awaiting = { id: 'f3', stage_id: 's3', pack_key: 'halfway', state: 'awaiting_approval', version: 1, whatsapp_template_id: 't3', body_text: 'Hi {{1}}, halfway.', body_texts: { main: 'Hi {{1}}, halfway.' } }
    const offRow = { id: 'f2', stage_id: 's1', pack_key: 'book_first_class', state: 'off', version: 1, whatsapp_template_id: 't2', body_text: 'Hi {{1}}, book.', body_texts: { main: 'Hi {{1}}, book.' } }
    let sent = null
    stubApi({
      board: { ...BOARD, followups: [offRow, ...BOARD.followups, awaiting] },
      patch: (body) => { sent = body; return ok({ board: BOARD }) },
    })
    renderPage()
    await screen.findByLabelText(/^Board name/)
    fireEvent.change(screen.getByLabelText('Offer name'), { target: { value: 'Autumn Reset' } })
    fireEvent.change(screen.getByLabelText('Sign-off'), { target: { value: 'Tim' } })
    fireEvent.change(screen.getByLabelText('Offer length in days'), { target: { value: '21' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const expected = 'These follow-ups still use the old offer name, sign-off and offer length: 1st Class, Day 7. Change their wording to update them.'
    expect(await screen.findByText(expected)).toBeTruthy()
    expect(staleWordingNotice(['offer name', 'sign-off', 'offer length'], ['1st Class', 'Day 7'])).toBe(expected)
    expect(sent.config).toMatchObject({ offer_name: 'Autumn Reset', signer: 'Tim', duration_days: 21 })
  })

  it('one changed value is named alone; a save that changes none of them shows no notice', async () => {
    stubApi({ patch: () => ok({ board: BOARD }) })
    renderPage()
    await screen.findByLabelText(/^Board name/)
    fireEvent.change(screen.getByLabelText('Sign-off'), { target: { value: 'Tim' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('These follow-ups still use the old sign-off: 1st Class. Change their wording to update them.')).toBeTruthy()

    cleanup()
    const board = { ...BOARD, config: { ...BOARD.config, offer_name: 'Spring Reset' } }
    stubApi({ board, patch: () => ok({ board }) })
    renderPage()
    // With an offer name set, the board name is not filled into any message.
    fireEvent.change(await screen.findByLabelText(/^Board name/), { target: { value: 'Spring board' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(screen.queryByText(/still use the old/)).toBeNull()
  })

  it('a rejected follow-up offers Change wording and Switch off, never a resend', async () => {
    const rejected = { id: 'f2', stage_id: 's1', pack_key: 'book_first_class', state: 'rejected', version: 1, whatsapp_template_id: 't2', body_text: 'Hi {{1}}, book now.', body_texts: { main: 'Hi {{1}}, book now.' } }
    const fetchMock = stubApi({ board: { ...BOARD, followups: [rejected, ...BOARD.followups] } })
    renderPage()
    expect(await screen.findByText(REJECTED_NOTE)).toBeTruthy()
    expect(REJECTED_NOTE).toBe('Meta rejected this wording. Change it to try again.')
    // Only the Day 7 stage (nothing installed) offers Install.
    expect(screen.getAllByRole('button', { name: 'Install' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Switch off' })).toHaveLength(2)
    fireEvent.click(screen.getAllByRole('button', { name: 'Change wording' })[0])
    expect(screen.getByRole('button', { name: 'Save wording' }).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Book the first class: message'), { target: { value: 'Hi {{1}}, pick a class at {studio}. {signer}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save wording' }))
    await waitFor(() => expect(calls(fetchMock, 'PUT')).toHaveLength(1))
    expect(JSON.parse(calls(fetchMock, 'PUT')[0][1].body)).toEqual({
      action: 'install', pack_key: 'book_first_class', bodies: { main: 'Hi {{1}}, pick a class at {studio}. {signer}' },
    })
  })

  it('turn off asks first, then calls disable', async () => {
    const fetchMock = stubApi({ board: { ...BOARD, enabled: true, baseline_at: '2026-11-06T00:00:00Z' } })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
    expect(screen.getByText(TURN_OFF_CONFIRM)).toBeTruthy()
    expect(TURN_OFF_CONFIRM).toBe('While the board is off, nobody new is placed and people already on it stay where they are, with no messages. When you turn it back on, people who qualified in the meantime are placed without messages. Follow-ups already on their way stop the next time they check the board, and turning it back on does not restart them.')
    expect(calls(fetchMock, 'POST')).toHaveLength(0)
    fireEvent.click(screen.getAllByRole('button', { name: 'Turn off' }).pop())
    await waitFor(() => expect(calls(fetchMock, 'POST')).toHaveLength(1))
    expect(calls(fetchMock, 'POST')[0][0]).toBe('/api/pipelines/b1/disable')
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

  it('noWhatsappHidesInstallWordingAndPublishAndSaysWhy', async () => {
    stubApi({ board: { ...BOARD, followups: [{ ...BOARD.followups[0], state: 'awaiting_approval' }] } })
    render(<BoardSettings boardId="b1" locationId="loc1" studioName="UN1T Stillorgan" hasWhatsapp={false} />)
    await screen.findByLabelText(/^Board name/)
    expect(screen.getByText(new RegExp(NO_WHATSAPP_NOTICE.slice(0, 40)))).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Change wording' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Publish now/ })).toBeNull()
  })

  it('withoutTheWhatsappPropTheFollowupButtonsStay', async () => {
    stubApi()
    renderPage()
    await screen.findByLabelText(/^Board name/)
    expect(screen.queryByText(new RegExp(NO_WHATSAPP_NOTICE.slice(0, 40)))).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Change wording' }).length).toBeGreaterThan(0)
  })
})
