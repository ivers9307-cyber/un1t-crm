import { describe, it, expect } from 'vitest'
import { TEAM_ACTIONS, TEAM_LINK_ONLY_KEYS } from '@/lib/approvals/team-actions'
import { TEAM_CARDS, TeamLinkCard } from './team-cards'
import TeamDecideCard from './TeamDecideCard'

describe('TEAM_CARDS', () => {
  it('has a card for every decidable provider', () => {
    for (const key of Object.keys(TEAM_ACTIONS)) expect(typeof TEAM_CARDS[key], key).toBe('function')
  })
  it('has no card for a link-only provider, and nothing else', () => {
    for (const key of TEAM_LINK_ONLY_KEYS) expect(TEAM_CARDS[key], key).toBeUndefined()
    expect(Object.keys(TEAM_CARDS).sort()).toEqual(Object.keys(TEAM_ACTIONS).sort())
  })
  it('maps the simple categories to the shared card and exports the link card', () => {
    expect(TEAM_CARDS.fte_expenses).toBe(TeamDecideCard)
    expect(TEAM_CARDS.time_off_cancellations).toBe(TeamDecideCard)
    // HOSTAUTOPUB.1 — host events publish with no approval: no card.
    expect(TEAM_CARDS.host_events).toBeUndefined()
    expect(typeof TeamLinkCard).toBe('function')
  })
})
