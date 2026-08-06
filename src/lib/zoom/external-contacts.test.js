import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client', () => ({ zoomFetch: vi.fn() }))
import { zoomFetch } from './client'
import {
  listOwnedContacts, createContact, updateContact, deleteContact, OWNED_PREFIX, markerFor,
} from './external-contacts'

beforeEach(() => { vi.mocked(zoomFetch).mockReset() })

describe('markerFor', () => {
  it('is dash-only and drops the plus', () => {
    expect(markerFor('+353871234567')).toBe('crm-353871234567')
    expect(markerFor('+353871234567')).not.toContain(':')
    expect(markerFor('+353871234567').startsWith(OWNED_PREFIX)).toBe(true)
  })
})

describe('listOwnedContacts', () => {
  it('pages until the token runs out and keeps only CRM-marked entries', async () => {
    vi.mocked(zoomFetch)
      .mockResolvedValueOnce({ ok: true, body: {
        next_page_token: 'p2',
        external_contacts: [
          { external_contact_id: 'z1', id: 'crm-353871111111', name: 'Aoife Ryan', phone_numbers: ['+353871111111'] },
          { external_contact_id: 'z2', id: 'plumber-joe', name: 'Joe the Plumber', phone_numbers: ['+353861111111'] },
        ],
      } })
      .mockResolvedValueOnce({ ok: true, body: {
        next_page_token: '',
        external_contacts: [
          { external_contact_id: 'z3', id: 'crm-353872222222', name: 'Cian Byrne', phone_numbers: ['+353872222222'] },
        ],
      } })

    const res = await listOwnedContacts()
    expect(res.ok).toBe(true)
    expect(res.contacts.size).toBe(2)
    expect(res.contacts.get('+353871111111')).toEqual({ zoomId: 'z1', name: 'Aoife Ryan' })
    // The hand-added plumber must be invisible, not merely skipped for writes.
    expect([...res.contacts.keys()]).not.toContain('+353861111111')
  })

  it('propagates a failure instead of returning a half-built map', async () => {
    vi.mocked(zoomFetch).mockResolvedValueOnce({ ok: false, status: 500, error: 'boom' })
    const res = await listOwnedContacts()
    expect(res.ok).toBe(false)
  })
})

describe('createContact', () => {
  it('sends the marker as id and the uuid as description', async () => {
    vi.mocked(zoomFetch).mockResolvedValueOnce({ ok: true, body: { external_contact_id: 'z9' } })
    const res = await createContact({ e164: '+353871234567', name: 'Niamh Walsh', contactId: 'uuid-1' })
    expect(res.ok).toBe(true)
    const [path, opts] = vi.mocked(zoomFetch).mock.calls[0]
    expect(path).toBe('/phone/external_contacts')
    expect(opts.method).toBe('POST')
    expect(opts.body.id).toBe('crm-353871234567')
    expect(opts.body.name).toBe('Niamh Walsh')
    expect(opts.body.phone_numbers).toEqual(['+353871234567'])
    expect(opts.body.description).toContain('uuid-1')
  })

  // Idempotency: an overlapping run re-enqueues a create that already landed.
  it('treats a 409 duplicate as success', async () => {
    vi.mocked(zoomFetch).mockResolvedValueOnce({ ok: false, status: 409, error: 'already exists' })
    const res = await createContact({ e164: '+353871234567', name: 'Niamh Walsh', contactId: 'uuid-1' })
    expect(res.ok).toBe(true)
    expect(res.duplicate).toBe(true)
  })

  it('reports a real failure', async () => {
    vi.mocked(zoomFetch).mockResolvedValueOnce({ ok: false, status: 400, error: 'bad number' })
    const res = await createContact({ e164: '+353871234567', name: 'Niamh Walsh', contactId: 'uuid-1' })
    expect(res.ok).toBe(false)
  })
})

describe('updateContact / deleteContact', () => {
  it('PATCHes by Zoom id', async () => {
    vi.mocked(zoomFetch).mockResolvedValueOnce({ ok: true, body: null })
    await updateContact({ zoomId: 'z1', name: 'New Name', contactId: 'uuid-2' })
    const [path, opts] = vi.mocked(zoomFetch).mock.calls[0]
    expect(path).toBe('/phone/external_contacts/z1')
    expect(opts.method).toBe('PATCH')
    expect(opts.body.name).toBe('New Name')
  })

  it('DELETEs by Zoom id and treats 404 as success', async () => {
    vi.mocked(zoomFetch).mockResolvedValueOnce({ ok: false, status: 404, error: 'gone' })
    const res = await deleteContact({ zoomId: 'z1' })
    expect(res.ok).toBe(true)
  })
})
