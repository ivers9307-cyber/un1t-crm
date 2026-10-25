// ROLEUI.2 — Linked accounts' Make primary / Unlink / Link buttons had no
// gate: every viewer saw them and POST/DELETE /api/contacts/[id]/link refused
// anyone without `contact_linking` at the contact's location. They now follow
// canManage (contactWorkGates.canLinkAccounts); the card itself (who is linked)
// still shows to everyone who can open the page.
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('next/dynamic', () => ({ default: () => () => null }))

const { default: LinkedAccountsCard } = await import('./LinkedAccountsCard.jsx')

const PERSON = {
  accounts: [
    { contactId: 'c-1', name: 'Account One', isPrimary: true, status: null },
    { contactId: 'c-2', name: 'Account Two', isPrimary: false, status: null },
  ],
}
const render = (props) => renderToStaticMarkup(<LinkedAccountsCard contactId="c-1" locationId="l-1" {...props} />)

describe('LinkedAccountsCard — the link buttons follow the route (ROLEUI.2)', () => {
  it('canManage: Make primary, Unlink and Link another', () => {
    const html = render({ person: PERSON, canManage: true })
    expect(html).toContain('Make primary')
    expect(html).toContain('Unlink')
    expect(html).toContain('Link another')
  })

  it('without canManage: the accounts still list, no buttons', () => {
    const html = render({ person: PERSON })
    expect(html).toContain('Account Two')
    expect(html).not.toContain('Make primary')
    expect(html).not.toContain('Unlink')
    expect(html).not.toContain('Link another')
  })

  it('an unlinked contact without canManage: no Link a duplicate button, and no copy pointing at it', () => {
    const html = render({ person: null })
    expect(html).not.toContain('Link a duplicate')
  })

  it('an unlinked contact with canManage: the Link a duplicate button', () => {
    expect(render({ person: null, canManage: true })).toContain('Link a duplicate')
  })
})
