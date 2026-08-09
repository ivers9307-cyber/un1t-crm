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
import { AUDIENCE_FIELDS } from '@/lib/audience-filter'

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

// ── FILTER-P1.1 — the dangerous default ──────────────────────────────
//
// addFilter used to hard-code `Stage = member` for every host. Since
// SEQEXIT.1 made a sequence's audience a CONTINUING condition (re-checked
// before every step), one click of "Add filter" in SequenceSettings both
// restricted enrolment to members AND exited every non-member mid-sequence.
// The host now supplies the default; with none, the row starts UNSET and is
// inert until a field is chosen.
describe('AudienceBuilder — host-supplied default row (P1.1)', () => {
  function addRow(props = {}) {
    const onChange = vi.fn()
    const { container } = render(
      <AudienceBuilder filter={{ logic: 'and', filters: [] }} onChange={onChange} audienceCount={null} {...props} />
    )
    const addBtn = Array.from(container.querySelectorAll('button')).find(b => /add filter/i.test(b.textContent))
    fireEvent.click(addBtn)
    return onChange
  }

  it('adds an UNSET row when the host supplies no default (sequences, contacts)', () => {
    const onChange = addRow()
    expect(onChange).toHaveBeenCalledWith({ logic: 'and', filters: [{ field: '', op: '', value: '' }] })
  })

  it('adds the host default row when one is supplied (send composers keep their guess)', () => {
    const onChange = addRow({ defaultFilterRow: { field: 'pipeline_stage_slug', op: 'eq', value: 'member' } })
    expect(onChange).toHaveBeenCalledWith({
      logic: 'and',
      filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }],
    })
  })

  it('renders an unset row as a "choose a field" placeholder with no operator or value control', () => {
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: '', op: '', value: '' }] }}
        onChange={() => {}}
        audienceCount={null}
      />
    )
    const selects = rowSelects(container)
    // Exactly one select: the field picker. No op select, no value control.
    expect(selects).toHaveLength(1)
    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(selects[0].value).toBe('')
    expect(optionValues(selects[0])[0]).toBe('')
    expect(selects[0].querySelector('option').textContent).toMatch(/choose a field/i)
  })

  it('does NOT render the unknown-field warning for an unset row', () => {
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: '', op: '', value: '' }] }}
        onChange={() => {}}
        audienceCount={null}
      />
    )
    expect(container.textContent).not.toMatch(/unsupported field/i)
  })

  it('choosing a field on an unset row fills in a usable op + value', () => {
    const onChange = vi.fn()
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: '', op: '', value: '' }] }}
        onChange={onChange}
        audienceCount={null}
      />
    )
    fireEvent.change(rowSelects(container)[0], { target: { value: 'pipeline_stage_slug' } })
    expect(onChange).toHaveBeenCalledWith({
      logic: 'and',
      filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'new_lead' }],
    })
  })

  it('lets an operator revert a chosen row back to unset', () => {
    const onChange = vi.fn()
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }}
        onChange={onChange}
        audienceCount={null}
      />
    )
    fireEvent.change(rowSelects(container)[0], { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith({ logic: 'and', filters: [{ field: '', op: '', value: '' }] })
  })
})

// ── FILTER-P1.3 — the tags field stops lying ─────────────────────────
//
// contacts.tags is TEXT[] DEFAULT '{}', and eq/contains compiled to the same
// `cs` element-membership test. So the field offered six ops that were really
// four, two of which ("is empty" / "is not empty") matched nobody and
// everybody respectively.
describe('AudienceBuilder — tags ops say what they do (P1.3)', () => {
  function tagsRow() {
    return render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'tags', op: 'eq', value: 'PTC' }] }}
        onChange={() => {}}
        audienceCount={null}
      />
    )
  }

  it('offers exactly four ops — no duplicate contains pair', () => {
    const { container } = tagsRow()
    const [, opSelect] = rowSelects(container)
    expect(optionValues(opSelect)).toEqual(['eq', 'neq', 'not_null', 'is_null'])
  })

  it('labels membership as "has tag" / "does not have tag", not equals/contains', () => {
    const { container } = tagsRow()
    const [, opSelect] = rowSelects(container)
    const labels = Array.from(opSelect.querySelectorAll('option')).map(o => o.textContent)
    expect(labels).toEqual(['has tag', 'does not have tag', 'has any tag', 'has no tags'])
  })

  it('leaves a scalar text field (Label) with its full contains-capable op list', () => {
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'label', op: 'eq', value: 'x' }] }}
        onChange={() => {}}
        audienceCount={null}
      />
    )
    const [, opSelect] = rowSelects(container)
    expect(optionValues(opSelect)).toContain('contains')
  })
})

// ── FILTER-P1.4 — switching to a date field must not create an unsaveable row
describe('AudienceBuilder — date rows are born saveable (P1.4)', () => {
  it('seeds a real date when a row is switched to a date field', () => {
    const onChange = vi.fn()
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'gender', op: 'eq', value: 'male' }] }}
        onChange={onChange}
        audienceCount={null}
      />
    )
    fireEvent.change(rowSelects(container)[0], { target: { value: 'created_at' } })
    const row = onChange.mock.calls.at(-1)[0].filters[0]
    expect(row.field).toBe('created_at')
    expect(row.op).toBe('gt')
    expect(row.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('swaps the value when the op moves between a date compare and a day-count', () => {
    const onChange = vi.fn()
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'created_at', op: 'gt', value: '2026-01-01' }] }}
        onChange={onChange}
        audienceCount={null}
      />
    )
    // date compare → day count: an ISO date is not a day count.
    fireEvent.change(rowSelects(container)[1], { target: { value: 'days_since_gt' } })
    expect(onChange.mock.calls.at(-1)[0].filters[0]).toEqual({
      field: 'created_at', op: 'days_since_gt', value: '30',
    })
  })

  it('swaps a day-count back to a real date when the op returns to a compare', () => {
    const onChange = vi.fn()
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'created_at', op: 'days_since_gt', value: '30' }] }}
        onChange={onChange}
        audienceCount={null}
      />
    )
    fireEvent.change(rowSelects(container)[1], { target: { value: 'lt' } })
    const row = onChange.mock.calls.at(-1)[0].filters[0]
    expect(row.op).toBe('lt')
    expect(row.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

// ── GAPS-P1.3 — engagement fields the builder was missing ─────────────────
//
// New audience fields go in BOTH registries: AUDIENCE_FIELDS (the server
// allowlist applyAudienceFilter enforces) and FIELD_OPTIONS (this builder).
// A field in only one is either invisible to operators or a guaranteed 400.
//   • last_email_open_at / last_email_click_at are new in mig 511 — "opened
//     in the last 30 days" is the whole reason the column was made real;
//   • total_emails_clicked has been server-allowlisted since mig 005 and was
//     simply never offered here, while its sibling total_emails_opened was.
describe('AudienceBuilder — engagement fields (GAPS-P1.3)', () => {
  function fieldOptionValues() {
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'created_at', op: 'gt', value: '2026-01-01' }] }}
        onChange={() => {}}
        audienceCount={null}
      />
    )
    return optionValues(rowSelects(container)[0])
  }

  it.each(['last_email_open_at', 'last_email_click_at', 'total_emails_clicked'])(
    'offers %s in the field dropdown',
    (field) => {
      expect(fieldOptionValues()).toContain(field)
    },
  )

  it('keeps every offered field inside the server allowlist (both-registries invariant)', () => {
    // '' is the FILTER-P1.1 unset-row placeholder ("Choose a field…"), not a
    // field — an unset row is inert and produces no predicate, so it is
    // deliberately absent from AUDIENCE_FIELDS. Every OTHER option must be
    // registered server-side, which is the invariant this pins.
    const unknown = fieldOptionValues()
      .filter(v => v !== '')
      .filter(v => !Object.hasOwn(AUDIENCE_FIELDS, v))
    expect(unknown).toEqual([])
  })
})
