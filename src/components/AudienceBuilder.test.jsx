// @vitest-environment jsdom
//
// COMMSFIX.B.3 — AudienceBuilder cleanup (2026-08-09 comms audit):
//   - the 'unsubscribed' email_status option is gone (mig 501 CHECK-bans the
//     value; it could never match a row and taught a wrong consent model);
//   - is empty / is not empty are offered on select, text and number fields
//     (and 'is not' on number fields), but ONLY where the server allowlist
//     (AUDIENCE_FIELDS) actually permits the op — a UI op the server rejects
//     would 400 at count time and the composer used to swallow that;
//   - a saved filter with an unknown/legacy field (e.g. pre-FUNNEL.1
//     lead_status) renders as an inert warning row instead of silently
//     masquerading as 'Stage';
//   - the `disabled` prop is real: selects/inputs/buttons are disabled and
//     no onChange fires (SMSBroadcastEditor passes it for locked broadcasts).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import AudienceBuilder from './AudienceBuilder.jsx'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function optionValues(select) {
  return Array.from(select.querySelectorAll('option')).map(o => o.value)
}

// The row layout is: field <select>, op <select>, [value control], remove.
function rowSelects(container) {
  return Array.from(container.querySelectorAll('select'))
}

describe('AudienceBuilder — dead email_status option removed (B3.1)', () => {
  it('no longer offers "unsubscribed" as an Email Status value', () => {
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'email_status', op: 'eq', value: 'active' }] }}
        onChange={() => {}}
        audienceCount={null}
      />
    )
    const [, , valueSelect] = rowSelects(container)
    expect(optionValues(valueSelect)).toEqual(['active', 'bounced', 'complained'])
  })
})

describe('AudienceBuilder — is empty / is not empty ops (B3.2)', () => {
  it('offers is empty / is not empty on a select field the server allows them on', () => {
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'glofox_membership_type', op: 'eq', value: 'time' }] }}
        onChange={() => {}}
        audienceCount={null}
      />
    )
    const [, opSelect] = rowSelects(container)
    expect(optionValues(opSelect)).toEqual(expect.arrayContaining(['eq', 'neq', 'is_null', 'not_null']))
  })

  it('does NOT offer is empty on email_status (server allowlist is eq/neq only)', () => {
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'email_status', op: 'eq', value: 'active' }] }}
        onChange={() => {}}
        audienceCount={null}
      />
    )
    const [, opSelect] = rowSelects(container)
    expect(optionValues(opSelect)).toEqual(['eq', 'neq'])
  })

  it('offers is empty / is not empty on a text field', () => {
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'label', op: 'eq', value: 'vip' }] }}
        onChange={() => {}}
        audienceCount={null}
      />
    )
    const [, opSelect] = rowSelects(container)
    expect(optionValues(opSelect)).toEqual(expect.arrayContaining(['is_null', 'not_null']))
  })

  it('offers "is not" (neq) on number fields', () => {
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'total_emails_sent', op: 'eq', value: '3' }] }}
        onChange={() => {}}
        audienceCount={null}
      />
    )
    const [, opSelect] = rowSelects(container)
    expect(optionValues(opSelect)).toEqual(expect.arrayContaining(['eq', 'neq', 'gt', 'lt', 'gte', 'lte']))
    // total_emails_sent has no is_null/not_null server-side — must not offer them.
    expect(optionValues(opSelect)).not.toContain('is_null')
  })

  it('offers is empty / is not empty on a nullable number field the server allows', () => {
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'glofox_membership_price_cents', op: 'eq', value: '5000' }] }}
        onChange={() => {}}
        audienceCount={null}
      />
    )
    const [, opSelect] = rowSelects(container)
    expect(optionValues(opSelect)).toEqual(expect.arrayContaining(['is_null', 'not_null']))
  })
})

describe('AudienceBuilder — unknown saved field renders an inert warning row (B3.3)', () => {
  it('shows the raw field name and the unsupported-field copy, not a Stage row', () => {
    const { container, getByText } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'lead_status', op: 'eq', value: 'active_trial' }] }}
        onChange={() => {}}
        audienceCount={null}
      />
    )
    getByText('lead_status')
    getByText('Saved with an unsupported field — remove this row')
    // No field/op/value selects for the broken row — only the delete button works.
    expect(rowSelects(container)).toHaveLength(0)
  })

  it('the remove button on a warning row deletes it', () => {
    const onChange = vi.fn()
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'lead_status', op: 'eq', value: 'x' }] }}
        onChange={onChange}
        audienceCount={null}
      />
    )
    const buttons = Array.from(container.querySelectorAll('button'))
    // The row's remove button is the first button before the Add filter footer.
    fireEvent.click(buttons[0])
    expect(onChange).toHaveBeenCalledWith({ filters: [], logic: 'and' })
  })
})

describe('AudienceBuilder — disabled prop (B3.4)', () => {
  function renderDisabled(onChange = vi.fn()) {
    return {
      onChange,
      ...render(
        <AudienceBuilder
          filter={{ logic: 'and', filters: [
            { field: 'pipeline_stage_slug', op: 'eq', value: 'member' },
            { field: 'glofox_membership_type', op: 'eq', value: 'time' },
          ] }}
          onChange={onChange}
          audienceCount={null}
          disabled
        />
      ),
    }
  }

  it('renders every select and button disabled', () => {
    const { container } = renderDisabled()
    for (const el of container.querySelectorAll('select, input, button')) {
      expect(el.disabled, `${el.tagName} should be disabled`).toBe(true)
    }
  })

  it('suppresses onChange even if events fire', () => {
    const { container, onChange } = renderDisabled()
    const selects = rowSelects(container)
    fireEvent.change(selects[0], { target: { value: 'gender' } })
    for (const btn of container.querySelectorAll('button')) fireEvent.click(btn)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('still allows edits when not disabled', () => {
    const onChange = vi.fn()
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }}
        onChange={onChange}
        audienceCount={null}
      />
    )
    const [fieldSelect] = rowSelects(container)
    fireEvent.change(fieldSelect, { target: { value: 'gender' } })
    expect(onChange).toHaveBeenCalled()
  })
})
