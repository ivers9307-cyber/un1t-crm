'use client'

// MIASETTINGS.2c — Cancellation form (CANCEL-FORM.2): "Cancel memberships in
// Glofox automatically" at the top, then the form's three steps. Its own
// duplicate Save button is gone: the page's Save covers it.

import CancellationFormFields from './CancellationFormFields'
import { CARD } from './field-renderer'

export default function CancellationSection({ agent, renderField, canEdit }) {
  const { settings, templates, setField } = agent
  return (
    <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0">
      <section className={CARD}>
        <h3 className="text-base font-semibold text-un1t-text mb-1">Membership cancellation form</h3>
        <p className="text-sm text-un1t-muted mb-4">
          Staff send a member a private, single-use link (by email or WhatsApp) to pause or cancel
          their membership. Submissions land in Approvals like any other request. Every word the member
          sees is editable here; leave a field blank to use the default shown. Placeholders:{' '}
          <code>{'{first_name}'}</code> <code>{'{plan}'}</code> <code>{'{location}'}</code>{' '}
          <code>{'{link}'}</code> <code>{'{end_date}'}</code> <code>{'{start_date}'}</code>.
        </p>
        {renderField('glofox_auto_cancel', { className: 'mb-4' })}
        <CancellationFormFields settings={settings} templates={templates} setField={setField} />
      </section>
    </fieldset>
  )
}
