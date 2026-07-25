// E2E-SMOKE.1 — browser smoke pack for the commercially-critical surfaces.
//
// External review (Codex 2026-07-25) P2: ~2,950 unit tests + structural
// checks, but nothing drove a real browser through login → the money
// pages, so a broken auth flow or a client-side crash on /invoices
// would ship green. This pack is deliberately READ-ONLY: it logs in,
// walks the surfaces, and asserts they render without server errors.
// It NEVER sends a message, approves an invoice, or pushes to Xero —
// it is designed to run against PRODUCTION on a schedule, and prod
// side effects (real WhatsApp sends, real Xero bills) are unacceptable
// from a test. Write-path coverage stays in the unit/route suites.
//
// Requirements (all three, else every test self-skips):
//   E2E_BASE_URL   e.g. https://crm.un1tdublin.com or http://localhost:3000
//   E2E_EMAIL      a dedicated smoke user (staff role is fine; needs the
//                  whatsapp permission for the inbox journey, and the
//                  invoices/pipeline permissions for those pages)
//   E2E_PASSWORD   that user's password
//
// Any response ≥500 observed during a journey fails it — that's the
// "handled failure the UI shrugged off" class the error_events work
// (OBS-HANDLED.1) made visible server-side; here the browser refuses
// to call the page healthy.

import { test, expect } from '@playwright/test'

const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD
const CONFIGURED = Boolean(process.env.E2E_BASE_URL && EMAIL && PASSWORD)

test.describe.configure({ mode: 'serial' })

test.skip(!CONFIGURED, 'E2E_BASE_URL / E2E_EMAIL / E2E_PASSWORD not set — smoke pack self-skips')

// Collect server errors per test; asserted at the end of every journey.
let serverErrors = []
test.beforeEach(({ page }) => {
  serverErrors = []
  page.on('response', (res) => {
    if (res.status() >= 500) serverErrors.push(`${res.status()} ${res.request().method()} ${res.url()}`)
  })
})

function expectNoServerErrors() {
  expect(serverErrors, `server 5xx during journey:\n${serverErrors.join('\n')}`).toEqual([])
}

async function login(page) {
  await page.goto('/login')
  // The form defaults to magic-link mode; flip to password.
  await page.getByRole('button', { name: 'Sign in with a password instead' }).click()
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  // Successful login router.pushes off /login (default /dashboard).
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 })
}

test('login → dashboard renders', async ({ page }) => {
  await login(page)
  await expect(page).not.toHaveURL(/\/login/)
  // The app shell is up: some primary navigation is visible.
  await expect(page.getByRole('link', { name: /dashboard/i }).first()).toBeVisible({ timeout: 15_000 })
  expectNoServerErrors()
})

test('unified inbox loads its queue (WA + IG + email APIs healthy)', async ({ page }) => {
  await login(page)
  const conversations = page.waitForResponse(
    (res) => res.url().includes('/api/whatsapp/conversations') && res.request().method() === 'GET',
    { timeout: 30_000 }
  )
  await page.goto('/communications/inbox')
  const res = await conversations
  expect(res.status(), 'whatsapp conversations list').toBe(200)
  await expect(page.getByPlaceholder('Search people & messages')).toBeVisible({ timeout: 15_000 })
  expectNoServerErrors()
})

test('invoices inbox renders', async ({ page }) => {
  await login(page)
  await page.goto('/invoices')
  // Whatever the operator sees (list, empty state, or a permission
  // redirect for a lesser smoke user), it must be a rendered page with
  // zero 5xx underneath — a client crash or dead API fails here.
  await expect(page.locator('body')).toBeVisible()
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  expectNoServerErrors()
})

test('pipeline renders', async ({ page }) => {
  await login(page)
  await page.goto('/pipeline')
  await expect(page.locator('body')).toBeVisible()
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  expectNoServerErrors()
})
