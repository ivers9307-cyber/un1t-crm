// @vitest-environment jsdom
//
// AUDIT-A11Y.2 — axe regression guard on the ui/ primitives.
//
// Every screen composes these, so locking their accessibility here protects the
// whole app (fix-once, protect-everywhere) and regression-locks the #1021 manual
// baseline: a future edit that drops an aria attribute from Button/Field/Modal
// fails CI instead of silently shipping. This is a jsdom-scoped file (docblock
// above) so the ~8,450 node tests keep running on environment:node untouched.
//
// Scope note: axe on jsdom validates structure/roles/labels/names, NOT colour
// contrast (needs real layout) — contrast is already lint-guarded by
// check:guardrails (no-low-contrast-chip).

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'
import { Button, Field, Modal, Table, Card, EmptyState, Loading } from '@/components/ui'

expect.extend(toHaveNoViolations)
afterEach(cleanup)

// Disable page-scoped rules: a primitive rendered in isolation has no page
// landmark/heading, so these fire as false positives at the component level.
// They belong to a full-page/E2E a11y pass, not a primitive smoke.
const AXE_OPTS = {
  rules: {
    region: { enabled: false },
    'landmark-one-main': { enabled: false },
    'page-has-heading-one': { enabled: false },
  },
}

async function expectNoViolations(ui) {
  render(ui)
  expect(await axe(document.body, AXE_OPTS)).toHaveNoViolations()
}

describe('ui primitives — axe a11y smoke', () => {
  it('Button — default', async () => {
    await expectNoViolations(<Button>Save</Button>)
  })

  it('Button — danger + loading (aria-busy)', async () => {
    await expectNoViolations(<Button variant="danger" loading>Delete</Button>)
  })

  it('Field — labelled control with error (aria-describedby/invalid)', async () => {
    await expectNoViolations(
      <Field id="email" label="Email" error="Email is required" required>
        {(props) => <input {...props} type="email" />}
      </Field>
    )
  })

  it('Modal — open + labelled (role=dialog, aria-modal, aria-labelledby)', async () => {
    await expectNoViolations(
      <Modal open title="Confirm deletion" onClose={() => {}}>
        This cannot be undone.
      </Modal>
    )
  })

  it('Table — columns + rows', async () => {
    await expectNoViolations(
      <Table
        columns={[{ key: 'name', header: 'Name', accessor: 'name' }, { key: 'email', header: 'Email', accessor: 'email' }]}
        rows={[{ name: 'Ann Lee', email: 'ann@example.com' }]}
      />
    )
  })

  it('Card — titled', async () => {
    await expectNoViolations(<Card title="This week">42 sessions</Card>)
  })

  it('EmptyState', async () => {
    await expectNoViolations(<EmptyState title="No contacts yet" description="Add your first contact to get started." />)
  })

  it('Loading', async () => {
    await expectNoViolations(<Loading label="Loading contacts" />)
  })
})
