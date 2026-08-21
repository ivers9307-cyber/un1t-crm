// DELETE /api/instagram/conversations/[id]/link — the unlink.
//
// BAREWRITE.1 fixed the bare `await` that cleared `contacts.instagram_igsid`,
// so a failed clear became a 500 instead of `{ success: true }`. That was only
// half the fix: the route nulled `instagram_conversations.contact_id` FIRST, so
// the retry the error message tells the operator to perform re-read a
// conversation whose `contact_id` was now null, skipped the identity clear
// entirely, and answered `{ success: true }` with the IGSID still set — the
// same silent re-link (resolveContactForInstagramThread looks a contact up by
// `instagram_igsid` and links on the spot), one click later, via the recovery
// path the error prescribes.
//
// The order is therefore load-bearing: identity first, thread second. These
// tests pin BOTH legs and, most importantly, the two-call retry sequence.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: vi.fn(() => null),
  requireInboxPermission: vi.fn(() => null),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/instagram-contact-link', () => ({ rankContactSuggestions: vi.fn(() => []) }))
vi.mock('@/lib/instagram-contact-link-server', () => ({ linkThreadToContact: vi.fn() }))

import { DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const CONV = 'c0000000-0000-0000-0000-0000000000aa'
const CONTACT = 'c0000000-0000-0000-0000-0000000000bb'
const IGSID = '17841400000000000'

// A tiny world that behaves like the real tables: the conversation row and the
// contact row are STATE, so a second DELETE call sees whatever the first left.
function makeWorld({ failContactUpdateTimes = 0, failConversationUpdate = false } = {}) {
  const state = {
    conversation: { id: CONV, contact_id: CONTACT, location_id: LOC, ig_user_id: IGSID, ig_username: 'someone', customer_name: 'Someone' },
    contactIgsid: IGSID,
    contactUpdateAttempts: 0,
  }
  let contactFailuresLeft = failContactUpdateTimes

  const db = {
    from(table) {
      if (table === 'instagram_conversations') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: { ...state.conversation }, error: null }) }) }),
          update: (patch) => ({
            eq: async () => {
              if (failConversationUpdate) return { error: { message: 'conversation write failed' } }
              Object.assign(state.conversation, patch)
              return { error: null }
            },
          }),
        }
      }
      if (table === 'contacts') {
        return {
          update: (patch) => {
            const filters = {}
            const b = {
              eq(col, val) { filters[col] = val; return b },
              then(resolve, reject) { return this._run().then(resolve, reject) },
              async _run() {
                state.contactUpdateAttempts++
                if (contactFailuresLeft > 0) {
                  contactFailuresLeft--
                  return { error: { message: 'connection reset' } }
                }
                // The `.eq('instagram_igsid', …)` guard: only clear when it
                // still points at this thread.
                if (filters.instagram_igsid === state.contactIgsid) {
                  state.contactIgsid = patch.instagram_igsid
                }
                return { error: null }
              },
            }
            return b
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db, state }
}

const req = () => new Request(`http://localhost/api/instagram/conversations/${CONV}/link`, { method: 'DELETE' })
const props = { params: Promise.resolve({ id: CONV }) }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', isMaster: true, locations: [{ id: LOC }] })
})

describe('DELETE /api/instagram/conversations/[id]/link', () => {
  it('clears the identity AND the thread on the happy path', async () => {
    const { db, state } = makeWorld()
    createServerClient.mockReturnValue(db)

    const res = await DELETE(req(), props)
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(state.contactIgsid).toBeNull()
    expect(state.conversation.contact_id).toBeNull()
  })

  it('leaves the thread LINKED when the identity clear fails — so a retry redoes both legs', async () => {
    const { db, state } = makeWorld({ failContactUpdateTimes: 1 })
    createServerClient.mockReturnValue(db)

    const first = await DELETE(req(), props)
    expect(first.status).toBe(500)
    expect((await first.json()).error).toMatch(/connection reset/)
    // Nothing half-applied: the identity stands AND the thread is still linked.
    expect(state.contactIgsid).toBe(IGSID)
    expect(state.conversation.contact_id).toBe(CONTACT)

    // THE REGRESSION. Under the old order the retry saw contact_id === null,
    // skipped the clear, and returned success with the IGSID still set.
    const second = await DELETE(req(), props)
    expect(second.status).toBe(200)
    expect((await second.json()).success).toBe(true)
    expect(state.contactIgsid).toBeNull()
    expect(state.conversation.contact_id).toBeNull()
    expect(state.contactUpdateAttempts).toBe(2)
  })

  it('never answers success while the IGSID is still set', async () => {
    // The clear keeps failing: every call must be a 500, never a success.
    const { db, state } = makeWorld({ failContactUpdateTimes: 5 })
    createServerClient.mockReturnValue(db)

    for (let i = 0; i < 3; i++) {
      const res = await DELETE(req(), props)
      expect(res.status).toBe(500)
      expect(state.contactIgsid).toBe(IGSID)
    }
  })

  it('surfaces a failed conversation update after the identity is already cleared', async () => {
    const { db, state } = makeWorld({ failConversationUpdate: true })
    createServerClient.mockReturnValue(db)

    const res = await DELETE(req(), props)
    expect(res.status).toBe(500)
    // The identity clear already landed; the retry's `.eq('instagram_igsid')`
    // guard turns it into a legitimate zero-row no-op.
    expect(state.contactIgsid).toBeNull()
    expect(state.conversation.contact_id).toBe(CONTACT)
  })
})
