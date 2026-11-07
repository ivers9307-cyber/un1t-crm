// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import BoardWizard from './BoardWizard.jsx'
import StagesStep from './wizard/StagesStep.jsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const OPTIONS = [
  { value: 'RESET39', label: '14 Day Reset', hint: '3 sales' },
  { value: 'TRIAL7', label: '7 day trial' },
]
function stubOptions(options = OPTIONS) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { options } }) })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
const props = { locationId: 'loc1', studioName: 'UN1T Stillorgan', canEdit: true, membershipSource: 'glofox' }
const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }))

describe('BoardWizard', () => {
  it('un1tStudioOffersUn1tProduct', async () => {
    stubOptions([{ value: 'p1', label: '14 Day Reset · €39' }])
    render(<BoardWizard {...props} membershipSource="un1t_online" />)
    expect(screen.queryByText("Offer boards at un1t.online studios aren't available yet.")).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Programme/ }))
    next()
    fireEvent.change(screen.getByLabelText(/Board name/), { target: { value: 'Hatch board' } })
    next()
    // The recipe's lead_source default does not work here: it starts on the first allowed type.
    expect(await screen.findByLabelText(/14 Day Reset/)).toBeTruthy()
    const select = screen.getByLabelText('Who enters')
    expect(screen.getByRole('option', { name: 'A un1t.online product' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'A Glofox plan' })).toBeNull()
    expect(select.value).toBe('un1t_product')
    expect(screen.getByText('People who buy this product enter the board.')).toBeTruthy()
  })

  it('a non-owner sees the owner notice and no wizard', () => {
    render(<BoardWizard {...props} canEdit={false} />)
    expect(screen.getByText('Only owners can build boards.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
  })

  it('wizardBlocksNextOnErrors', async () => {
    stubOptions()
    render(<BoardWizard {...props} />)
    next()
    expect(screen.getByText('Pick a recipe.')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Recipe' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Paid trial/ }))
    next()
    expect(screen.getByRole('heading', { name: 'Name and offer' })).toBeTruthy()
    next()
    expect(screen.getByText('Give the board a name.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Board name/), { target: { value: 'Spring reset' } })
    next()

    expect(screen.getByRole('heading', { name: 'Who enters' })).toBeTruthy()
    expect(screen.getByText('People who buy a trial with plan code…')).toBeTruthy()
    await screen.findByLabelText(/14 Day Reset/)
    next()
    expect(screen.getByText('Pick at least one option.')).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/14 Day Reset/))
    next()
    expect(screen.getByRole('heading', { name: 'Stages' })).toBeTruthy()
  })

  it('fetches entry options for the type and match', async () => {
    const fetchMock = stubOptions()
    render(<BoardWizard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Paid trial/ }))
    next()
    fireEvent.change(screen.getByLabelText(/Board name/), { target: { value: 'Spring reset' } })
    next()
    await screen.findByLabelText(/14 Day Reset/)
    expect(fetchMock).toHaveBeenCalledWith('/api/locations/loc1/pipeline-entry-options?type=trial_purchase&match=plan_code')
    fireEvent.change(screen.getByLabelText('Match on'), { target: { value: 'landing_path' } })
    await screen.findByText('People who buy a trial on landing page path…')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/locations/loc1/pipeline-entry-options?type=trial_purchase&match=landing_path')
  })

  async function toStages() {
    stubOptions()
    render(<BoardWizard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Paid trial/ }))
    next()
    fireEvent.change(screen.getByLabelText(/Board name/), { target: { value: 'Spring reset' } })
    next()
    fireEvent.click(await screen.findByLabelText(/14 Day Reset/))
    next()
  }

  it('the new stage is locked and the recipe check-in day is fixed', async () => {
    await toStages()
    const newBox = screen.getByLabelText('Use the New Leads stage')
    expect(newBox.checked).toBe(true)
    expect(newBox.disabled).toBe(true)
    expect(screen.queryByLabelText('Check-in day for Day 7')).toBeNull()
    expect(screen.getByText("Fixed at day 7 for this recipe's check-in message.")).toBeTruthy()
  })

  it('a check-in without a follow-up pack keeps an editable day', () => {
    const dispatch = vi.fn()
    const state = {
      stages: [
        { role: 'new', name: 'New', defaultName: 'New', enabled: true, locked: true },
        { role: 'checkpoint', name: 'Day 3', defaultName: 'Day 3', day: 3, enabled: true, locked: false },
      ],
    }
    render(<StagesStep state={state} dispatch={dispatch} />)
    const day = screen.getByLabelText('Check-in day for Day 3')
    fireEvent.change(day, { target: { value: '9' } })
    expect(dispatch).toHaveBeenCalledWith({ type: 'setStageDay', index: 1, day: '9' })
    expect(screen.queryByText(/Fixed at day/)).toBeNull()
  })

  it('follow-ups default to the recipe wording and preview with Tim', async () => {
    await toStages()
    next()
    expect(screen.getByRole('heading', { name: 'Follow-ups' })).toBeTruthy()
    const box = screen.getByLabelText('End of trial: follow-up if they don\'t reply')
    expect(box.value).toContain('Hey {{1}}, just bumping this')
    expect(screen.getByText(/Hey Tim, just bumping this/)).toBeTruthy()
    expect(screen.getAllByText(/is the person's first name/).length).toBeGreaterThan(0)
    fireEvent.change(box, { target: { value: 'Hello there' } })
    expect(screen.getByText('the message must include {{1}} (the first name)')).toBeTruthy()
    next()
    expect(screen.getByRole('heading', { name: 'Follow-ups' })).toBeTruthy()
  })

  it('reaches review with the create button', async () => {
    await toStages()
    next()
    next()
    expect(screen.getByRole('heading', { name: 'Notes for Mia' })).toBeTruthy()
    next()
    expect(screen.getByRole('heading', { name: 'Review' })).toBeTruthy()
    expect(screen.getByText('Spring reset')).toBeTruthy()
    expect(screen.getByText('RESET39')).toBeTruthy()
    const onCreate = vi.fn()
    cleanup()
    stubOptions()
    render(<BoardWizard {...props} onCreate={onCreate} />)
    fireEvent.click(screen.getByRole('button', { name: /Paid trial/ }))
    next()
    fireEvent.change(screen.getByLabelText(/Board name/), { target: { value: 'Spring reset' } })
    next()
    fireEvent.click(await screen.findByLabelText(/14 Day Reset/))
    for (let i = 0; i < 4; i += 1) next()
    fireEvent.click(screen.getByRole('button', { name: 'Create board (switched off)' }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0][0].name).toBe('Spring reset')
  })
})
