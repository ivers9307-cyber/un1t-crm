// E2EPUBLIC.1 — the two public journeys a customer takes without logging in:
// booking a consultation, and the /trial card up to the payment step.
//
// These run against PRODUCTION every day, so they must never leave a mark:
//   - each journey stops one click short of the write ("Confirm booking", the
//     trial's pay button), and neither button is ever pressed;
//   - as a second lock, every non-GET request is refused in the browser and
//     fails the test, so a click that starts to write cannot reach the server;
//   - requests to other hosts and to Vercel's analytics are refused, so a test
//     run never counts as a visitor or fires the Meta pixel.
//
// Needs only E2E_BASE_URL (no login). Any response of 500 or above, and any
// uncaught error in the page, fails the journey.

import { test, expect } from '@playwright/test'

const BASE_URL = process.env.E2E_BASE_URL
// One live consultation type per studio. Renaming one of these slugs breaks
// its public link too, so a failure here is worth seeing.
const BOOKING_SLUGS = ['free-un1t-consultation', 'on-boarding-consultation']
const MONTHS_TO_TRY = 3
const DAYS_PER_MONTH_TO_TRY = 8
const SLOT_TIME = /^\d{1,2}:\d{2}(am|pm)$/

test.skip(!BASE_URL, 'Set E2E_BASE_URL to run the public journeys')

const noProblems = () => ({ writes: [], serverErrors: [], pageErrors: [] })
let problems = noProblems()

test.beforeEach(async ({ page }) => {
  problems = noProblems()
  const origin = new URL(BASE_URL).origin
  await page.route('**/*', (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (!['GET', 'HEAD'].includes(request.method())) {
      problems.writes.push(`${request.method()} ${url.pathname}`)
      return route.abort()
    }
    if (url.origin !== origin || url.pathname.startsWith('/_vercel/')) return route.abort()
    return route.continue()
  })
  page.on('response', (res) => {
    if (res.status() >= 500) problems.serverErrors.push(`${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`)
  })
  page.on('pageerror', (err) => problems.pageErrors.push(err.message))
})

test.afterEach(() => {
  expect(problems.writes, 'the journey tried to write').toEqual([])
  expect(problems.serverErrors, 'the server failed a request').toEqual([])
  expect(problems.pageErrors, 'the page threw an error').toEqual([])
})

/** Tries open days until one shows a time; moves on a month when they run out. */
async function openFirstDayWithTimes(page) {
  const times = page.getByRole('button', { name: SLOT_TIME })
  for (let month = 0; month < MONTHS_TO_TRY; month++) {
    const openDays = page.getByRole('button', { name: /^\d{1,2}$/ }).and(page.locator(':enabled'))
    const count = Math.min(await openDays.count(), DAYS_PER_MONTH_TO_TRY)
    for (let day = 0; day < count; day++) {
      const slots = page.waitForResponse((res) => res.url().includes('/slots?date='))
      await openDays.nth(day).click()
      await slots
      // The list renders just after its response lands.
      if (await times.first().waitFor({ timeout: 2_000 }).then(() => true, () => false)) return times
    }
    await page.getByRole('button', { name: 'Next month' }).click()
  }
  throw new Error(`No bookable time in the next ${MONTHS_TO_TRY} months`)
}

for (const slug of BOOKING_SLUGS) {
  test(`booking ${slug}: choose a time and reach the details form`, async ({ page }) => {
    await page.goto(`/book/${slug}`)
    await expect(page.getByRole('heading', { level: 1 })).not.toBeEmpty()
    await expect(page.getByRole('heading', { name: 'Select a date & time' })).toBeVisible()

    const times = await openFirstDayWithTimes(page)
    await times.first().click()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()

    await expect(page.getByPlaceholder('Your name')).toBeVisible()
    await expect(page.getByPlaceholder('you@example.com')).toBeVisible()
    // The end of the journey: this button is checked and never pressed.
    await expect(page.getByRole('button', { name: 'Confirm booking' })).toBeEnabled()
  })
}

/** The class step: a time from the timetable, or the way past an empty one. */
async function passClassStep(page) {
  await expect(page.getByText('Checking the timetable…')).toBeHidden({ timeout: 20_000 })
  const tiles = page.locator('[data-tile]')
  if (await tiles.count() === 0) {
    await page.getByRole('status').locator('xpath=following-sibling::button').click()
    return
  }
  // With several classes a day, tapping a time also moves on.
  const dayFirst = await page.getByRole('group', { name: 'Class' }).count() > 0
  await tiles.first().click()
  if (!dayFirst) await tiles.first().locator('xpath=../following-sibling::button').last().click()
}

test('/trial: every studio on sale reaches the details form', async ({ page }) => {
  await page.goto('/trial')
  await expect(page.getByRole('heading', { name: 'Choose your studio' })).toBeVisible()
  const onSale = page.getByRole('button', { name: /\d+ days/ }).and(page.locator(':enabled'))
  await expect(onSale.first()).toBeVisible()
  const studios = await onSale.count()

  for (let i = 0; i < studios; i++) {
    await test.step(`studio ${i + 1} of ${studios}`, async () => {
      if (i > 0) await page.goto('/trial')
      await onSale.nth(i).click()
      await passClassStep(page)

      const form = page.getByRole('form', { name: 'Your details' })
      for (const field of ['First name', 'Last name', 'Email', 'Phone']) {
        await expect(form.getByPlaceholder(field)).toBeVisible()
      }
      // The end of the journey: this button is checked and never pressed.
      await expect(form.locator('button[type="submit"]')).toBeEnabled()
      await expect(form.locator('button[type="submit"]')).toContainText('€')
    })
  }
})
