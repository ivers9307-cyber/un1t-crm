// @vitest-environment jsdom
//
// FINDTEAM.6 — the "Looking for a team" group on the Teams page: confirmed
// solo entrants (looking_for_team), a Place in team control per row, and
// Pair up for a new team. A placed row keeps its card with a chip and no actions.
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react'
import RaceTeamsManager from './RaceTeamsManager.jsx'

const race = {
  id: 'e1',
  allowed_team_sizes: [1, 2],
  waves: [
    { id: 'w1', start_time: '09:00:00', label: 'Wave 1', display_order: 0 },
    { id: 'w2', start_time: '10:00:00', label: null, display_order: 1 },
  ],
}

const paid = { id: 'p', status: 'completed' }
const solo = (id, first, last, wave_id, extra = {}) => ({
  id, status: 'confirmed', wave_id, looking_for_team: true, placed_into_registration_id: null,
  contact: { first_name: first, last_name: last, email: `${first.toLowerCase()}@example.com`, phone: '+353871234567' },
  lead_name: `${first} ${last}`,
  teams: { id: `t-${id}`, name: `${first} ${last} (looking for a team)`, size: 1, team_members: [] },
  payment: paid, last_move: null, ...extra,
})
const team = (id, name, wave_id) => ({
  id, status: 'confirmed', wave_id, looking_for_team: false, placed_into_registration_id: null,
  contact: { first_name: 'Cap', last_name: name, email: 'cap@example.com', phone: null },
  teams: { id: `t-${id}`, name, size: 2, team_members: [] },
  payment: paid, last_move: null,
})

const S1 = solo('s1', 'Aoife', 'Byrne', 'w1')
const S2 = solo('s2', 'Conor', 'Walsh', 'w2')
const S3 = solo('s3', 'Niamh', 'Doyle', 'w1')
const TA = team('tA', 'Team Alpha', 'w1')
const TB = team('tB', 'Team Bravo', 'w2')
const PLACED = solo('p1', 'Dana', 'Kelly', 'w1', { status: 'placed', placed_into_registration_id: 'tA' })

let data
let posts
let postReply
let gets
beforeEach(() => {
  data = [S1, S2, TA, TB, PLACED]
  posts = []
  gets = 0
  postReply = { ok: true, status: 200, body: { success: true, data: { placed: true } } }
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    if (opts?.method === 'POST') {
      posts.push({ url: String(url), body: JSON.parse(opts.body) })
      return { ok: postReply.ok, status: postReply.status, json: async () => postReply.body }
    }
    gets += 1
    return { ok: true, status: 200, json: async () => ({ success: true, data: data, moved_out: [] }) }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const group = () => screen.getByRole('region', { name: /Looking for a team/ })

describe('RaceTeamsManager — Looking for a team group', () => {
  it('lists the confirmed solos with wave, email, phone and paid', async () => {
    render(<RaceTeamsManager race={race} />)
    await screen.findByRole('region', { name: /Looking for a team/ })
    const g = within(group())
    expect(g.getByText('Aoife Byrne')).toBeTruthy()
    expect(g.getByText('Conor Walsh')).toBeTruthy()
    expect(g.getByText('aoife@example.com')).toBeTruthy()
    expect(g.getAllByText('+353871234567')).toHaveLength(2)
    expect(g.getAllByText('Paid')).toHaveLength(2)
    expect(g.getByText(/Wave 1 · 09:00/)).toBeTruthy()
    expect(g.getByText(/^10:00$/)).toBeTruthy()
    // the placed solo is not in the queue
    expect(g.queryByText('Dana Kelly')).toBeNull()
  })

  it('is absent when nobody is looking for a team', async () => {
    data = [TA, TB, PLACED]
    render(<RaceTeamsManager race={race} canPlaceSolos />)
    await screen.findByText(/3 teams registered/)
    expect(screen.queryByRole('region', { name: /Looking for a team/ })).toBeNull()
  })

  it('shows the rows but no Place or Pair controls without canPlaceSolos', async () => {
    render(<RaceTeamsManager race={race} />)
    await screen.findByRole('region', { name: /Looking for a team/ })
    const g = within(group())
    expect(g.getByText('Aoife Byrne')).toBeTruthy()
    expect(g.queryByRole('button', { name: /Place/ })).toBeNull()
    expect(g.queryByRole('button', { name: /Pair up/ })).toBeNull()
    expect(g.queryByRole('checkbox')).toBeNull()
    expect(g.queryByRole('combobox')).toBeNull()
  })

  it('Place in team offers confirmed non-solo teams, same wave first, other waves with their time', async () => {
    render(<RaceTeamsManager race={race} canPlaceSolos />)
    await screen.findByRole('region', { name: /Looking for a team/ })
    const select = screen.getByLabelText('Place Aoife Byrne in a team')
    const same = select.querySelector('optgroup[label="Same wave"]')
    const other = select.querySelector('optgroup[label="Other waves"]')
    expect([...same.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Team Alpha'])
    expect([...other.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Team Bravo · 10:00'])
    // never a solo, never the placed row
    expect(select.textContent).not.toMatch(/looking for a team\)/)
  })

  it('Place POSTs { team_registration_id } to the place route and reloads', async () => {
    render(<RaceTeamsManager race={race} canPlaceSolos />)
    await screen.findByRole('region', { name: /Looking for a team/ })
    const before = gets
    fireEvent.change(screen.getByLabelText('Place Aoife Byrne in a team'), { target: { value: 'tA' } })
    fireEvent.click(within(group()).getByRole('button', { name: 'Place Aoife Byrne' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ url: '/api/registrations/s1/place', body: { team_registration_id: 'tA' } })
    await waitFor(() => expect(gets).toBe(before + 1))
  })

  it('Place is disabled until a team is chosen', async () => {
    render(<RaceTeamsManager race={race} canPlaceSolos />)
    await screen.findByRole('region', { name: /Looking for a team/ })
    expect(within(group()).getByRole('button', { name: 'Place Aoife Byrne' }).disabled).toBe(true)
  })

  // FINDTEAM.8 (M5) — a team in another wave is confirmed first.
  it('a team in another wave asks first; declining sends nothing', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<RaceTeamsManager race={race} canPlaceSolos />)
    await screen.findByRole('region', { name: /Looking for a team/ })
    fireEvent.change(screen.getByLabelText('Place Aoife Byrne in a team'), { target: { value: 'tB' } })
    fireEvent.click(within(group()).getByRole('button', { name: 'Place Aoife Byrne' }))
    expect(confirm).toHaveBeenCalledWith('Aoife Byrne is in the 09:00 wave but this team runs at 10:00. Place them anyway?')
    expect(posts).toHaveLength(0)
    confirm.mockRestore()
  })

  it('a team in another wave places once confirmed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<RaceTeamsManager race={race} canPlaceSolos />)
    await screen.findByRole('region', { name: /Looking for a team/ })
    fireEvent.change(screen.getByLabelText('Place Aoife Byrne in a team'), { target: { value: 'tB' } })
    fireEvent.click(within(group()).getByRole('button', { name: 'Place Aoife Byrne' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toEqual({ team_registration_id: 'tB' })
    confirm.mockRestore()
  })

  it('a team in the same wave never asks', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    render(<RaceTeamsManager race={race} canPlaceSolos />)
    await screen.findByRole('region', { name: /Looking for a team/ })
    fireEvent.change(screen.getByLabelText('Place Aoife Byrne in a team'), { target: { value: 'tA' } })
    fireEvent.click(within(group()).getByRole('button', { name: 'Place Aoife Byrne' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('a refused Place shows the route message', async () => {
    postReply = { ok: false, status: 409, body: { success: false, error: 'already_placed', message: 'That entrant has already been placed in a team. Reload to see where.' } }
    render(<RaceTeamsManager race={race} canPlaceSolos />)
    await screen.findByRole('region', { name: /Looking for a team/ })
    fireEvent.change(screen.getByLabelText('Place Aoife Byrne in a team'), { target: { value: 'tA' } })
    fireEvent.click(within(group()).getByRole('button', { name: 'Place Aoife Byrne' }))
    await screen.findByText(/already been placed in a team/)
  })
})

describe('RaceTeamsManager — Pair up', () => {
  const pairButton = () => within(group()).getByRole('button', { name: /Pair up/ })

  it('is disabled until two are ticked', async () => {
    render(<RaceTeamsManager race={race} canPlaceSolos />)
    await screen.findByRole('region', { name: /Looking for a team/ })
    expect(pairButton().disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Select Aoife Byrne'))
    expect(pairButton().disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Select Conor Walsh'))
    expect(pairButton().disabled).toBe(false)
  })

  it('two solos in the same wave: POSTs registration_ids and team_name with no wave_id', async () => {
    data = [S1, S3, TA, TB]
    render(<RaceTeamsManager race={race} canPlaceSolos />)
    await screen.findByRole('region', { name: /Looking for a team/ })
    fireEvent.click(screen.getByLabelText('Select Aoife Byrne'))
    fireEvent.click(screen.getByLabelText('Select Niamh Doyle'))
    fireEvent.click(pairButton())
    expect(screen.getByLabelText('Team name').value).toBe('Team Aoife & Niamh')
    expect(screen.queryByLabelText('Wave for the new team')).toBeNull()
    fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'The Pair' } })
    const before = gets
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].url).toBe('/api/events/e1/pair-solos')
    expect(posts[0].body).toEqual({ registration_ids: ['s1', 's3'], team_name: 'The Pair' })
    expect('wave_id' in posts[0].body).toBe(false)
    await waitFor(() => expect(gets).toBe(before + 1))
    // the panel closes and the ticks clear
    await waitFor(() => expect(screen.queryByLabelText('Team name')).toBeNull())
    expect(screen.getByLabelText('Select Aoife Byrne').checked).toBe(false)
  })

  it('solos in different waves: a wave select is shown, required, and its choice is sent', async () => {
    postReply = { ok: true, status: 200, body: { success: true, data: { registration_id: 'new' } } }
    render(<RaceTeamsManager race={race} canPlaceSolos />)
    await screen.findByRole('region', { name: /Looking for a team/ })
    fireEvent.click(screen.getByLabelText('Select Aoife Byrne'))
    fireEvent.click(screen.getByLabelText('Select Conor Walsh'))
    fireEvent.click(pairButton())
    const wave = screen.getByLabelText('Wave for the new team')
    const create = screen.getByRole('button', { name: 'Create team' })
    expect(create.disabled).toBe(true)
    fireEvent.change(wave, { target: { value: 'w2' } })
    expect(create.disabled).toBe(false)
    fireEvent.click(create)
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toEqual({ registration_ids: ['s1', 's2'], team_name: 'Team Aoife & Conor', wave_id: 'w2' })
  })

  it('a wave_full refusal shows its message and Place anyway retries with force: true', async () => {
    data = [S1, S3, TA, TB]
    postReply = { ok: false, status: 409, body: { success: false, error: 'wave_full', code: 'wave_full', message: 'That wave has no team places left.', spots_left: 0 } }
    render(<RaceTeamsManager race={race} canPlaceSolos />)
    await screen.findByRole('region', { name: /Looking for a team/ })
    fireEvent.click(screen.getByLabelText('Select Aoife Byrne'))
    fireEvent.click(screen.getByLabelText('Select Niamh Doyle'))
    fireEvent.click(pairButton())
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }))
    await screen.findByText('That wave has no team places left.')
    expect('force' in posts[0].body).toBe(false)
    postReply = { ok: true, status: 200, body: { success: true, data: { registration_id: 'new' } } }
    fireEvent.click(screen.getByRole('button', { name: 'Place anyway' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1].body).toEqual({ ...posts[0].body, force: true })
    await waitFor(() => expect(screen.queryByLabelText('Team name')).toBeNull())
  })

  it('any other refusal goes to the page error, with no Place anyway', async () => {
    data = [S1, S3, TA, TB]
    postReply = { ok: false, status: 409, body: { success: false, error: 'team_name_taken', message: 'A team with that name already exists on this event.' } }
    render(<RaceTeamsManager race={race} canPlaceSolos />)
    await screen.findByRole('region', { name: /Looking for a team/ })
    fireEvent.click(screen.getByLabelText('Select Aoife Byrne'))
    fireEvent.click(screen.getByLabelText('Select Niamh Doyle'))
    fireEvent.click(pairButton())
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }))
    await screen.findByText('A team with that name already exists on this event.')
    expect(screen.queryByRole('button', { name: 'Place anyway' })).toBeNull()
  })
})

describe('RaceTeamsManager — a placed entry', () => {
  it('shows Placed → team {name} and no actions on its card', async () => {
    render(<RaceTeamsManager race={race} canCancelEntries canMoveEntries canPlaceSolos />)
    const chip = await screen.findByText('Placed → team Team Alpha')
    expect(chip).toBeTruthy()
    // five rows, four actionable: the placed one has no Cancel / Move / Remove
    expect(screen.getAllByRole('button', { name: /Cancel entry/ })).toHaveLength(4)
    expect(screen.getAllByRole('button', { name: /Move to event/ })).toHaveLength(4)
    expect(screen.getAllByRole('button', { name: /Remove/ })).toHaveLength(4)
    const card = chip.closest('.bg-un1t-surface')
    expect(within(card).queryByRole('button')).toBeNull()
  })

  it('falls back to Placed when the team entry is not in the list', async () => {
    data = [{ ...PLACED, placed_into_registration_id: 'gone' }]
    render(<RaceTeamsManager race={race} canCancelEntries />)
    await screen.findByText(/1 team registered/)
    expect(screen.getByText('Placed')).toBeTruthy()
  })
})
