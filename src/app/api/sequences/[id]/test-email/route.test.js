// FLOWTEST.1 — POST /api/sequences/[id]/test-email through the real withAuth
// wrapper: email at the sequence's studio, 404 for another studio's, and one
// [TEST] email to the caller only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/postmark', async (importOriginal) => ({ ...(await importOriginal()), sendEmail: vi.fn(async () => ({ messageId: 'm1' })) }))
vi.mock('@/lib/tenant-email', () => ({ resolveEmailSender: vi.fn(async () => ({ fromEmail: 'hello@example.test' })) }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://crm.example.test') }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'Studio Co' })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { sendEmail } = await import('@/lib/postmark')
const { POST } = await import('./route.js')

const SEQ_A = '5e000000-0000-4000-8000-00000000000a'
const SEQ_B = '5e000000-0000-4000-8000-00000000000b'
const TPL_A = '7e000000-0000-4000-8000-00000000000a'
const EMAIL_A = { ...person({ [LOC_A]: { role: 'manager', permissions: { email: true } } }, LOC_A), email: 'Staff@Example.test', full_name: 'Sam Staff' }

const call = (id, body) => POST(new Request(`http://localhost/api/sequences/${id}/test-email`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) })

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    email_sequences: [{ id: SEQ_A, location_id: LOC_A, name: 'A' }, { id: SEQ_B, location_id: LOC_B, name: 'B' }],
    locations: [{ id: LOC_A, name: 'Studio A', timezone: 'Europe/Dublin' }],
    email_templates: [{ id: TPL_A, location_id: LOC_A, subject: 'From the template', html_content: '<p>Template {{first_name}}</p>' }],
    contacts: [],
  } })
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(EMAIL_A)
})

describe('POST /api/sequences/[id]/test-email', () => {
  it('sends one [TEST] email to the caller with merge tags filled', async () => {
    const res = await call(SEQ_A, { subject: 'Hi {{first_name}}', html_content: '<p>Hello {{first_name}}</p>' })
    expect(res.status).toBe(200)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const arg = sendEmail.mock.calls[0][0]
    expect(arg.to).toBe('staff@example.test')
    expect(arg.subject).toBe('[TEST] Hi Sam')
    expect(arg.htmlBody).toContain('Hello Sam')
    expect(arg.stream).toBe('broadcast')
  })

  it('uses the saved template, and its subject when the step has none', async () => {
    await call(SEQ_A, { subject: '', template_id: TPL_A })
    const arg = sendEmail.mock.calls[0][0]
    expect(arg.subject).toBe('[TEST] From the template')
    expect(arg.htmlBody).toContain('Template Sam')
  })

  it('404 for another studio’s automation, nothing sent', async () => {
    const res = await call(SEQ_B, { subject: 'x', html_content: '<p>x</p>' })
    expect(res.status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('400 when there is nothing to send', async () => {
    const res = await call(SEQ_A, { subject: 'x' })
    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
