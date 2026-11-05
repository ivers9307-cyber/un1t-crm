'use client'

// CANCEL-FORM.2 — the membership cancellation form's three steps (The form
// page, Sending the link, After you decide), moved verbatim from
// CustomerAgentClient (MIASETTINGS.2c). Placeholders and reason codes come
// from the pure copy module (no server-only imports), so the editor's
// defaults can never drift from what the form actually renders. The block is
// studio-only, always saved whole (no override bookkeeping).

import { CANCELLATION_FORM_DEFAULTS, REASON_CODES } from '@/lib/cancellation-form/defaults'
import { inputCls } from './field-renderer'

const CF_DEFAULTS = CANCELLATION_FORM_DEFAULTS
const CF_REASON_CODES = REASON_CODES

export default function CancellationFormFields({ settings, templates, setField }) {
  const setCancelForm = (key, value) => setField(`cancellation_form.${key}`, value)
  const setCancelReason = (code, value) => setField(`cancellation_form.reason_labels.${code}`, value)
  return (
    <>
      <h3 className="text-sm font-semibold text-un1t-text mt-4 mb-2">The form page</h3>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Intro</label>
          <textarea className={inputCls} rows={2} maxLength={1000} value={settings.cancellation_form?.form_intro || ''}
            onChange={e => setCancelForm('form_intro', e.target.value)}
            placeholder={CF_DEFAULTS.form_intro} />
        </div>
        <label className="flex items-center gap-2 text-sm text-un1t-text">
          <input type="checkbox" checked={settings.cancellation_form?.pause_offer_enabled !== false}
            onChange={e => setCancelForm('pause_offer_enabled', e.target.checked)} />
          Offer a pause before the cancel details
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Pause offer text</label>
            <textarea className={inputCls} rows={2} maxLength={500} value={settings.cancellation_form?.pause_offer_text || ''}
              onChange={e => setCancelForm('pause_offer_text', e.target.value)}
              placeholder={CF_DEFAULTS.pause_offer_text} />
          </div>
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Longest pause (weeks)</label>
            <input type="number" min={1} max={26} className={inputCls}
              value={settings.cancellation_form?.pause_max_weeks ?? ''}
              placeholder={String(CF_DEFAULTS.pause_max_weeks)}
              onChange={e => setCancelForm('pause_max_weeks', e.target.value === '' ? null : Number(e.target.value))} />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Reason options (shown as the member&apos;s choices)</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {CF_REASON_CODES.map(code => (
              <input key={code} className={inputCls} maxLength={80}
                value={settings.cancellation_form?.reason_labels?.[code] || ''}
                onChange={e => setCancelReason(code, e.target.value)}
                placeholder={CF_DEFAULTS.reason_labels[code]} />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">End date help text</label>
            <textarea className={inputCls} rows={2} maxLength={500} value={settings.cancellation_form?.end_date_help_text || ''}
              onChange={e => setCancelForm('end_date_help_text', e.target.value)}
              placeholder={CF_DEFAULTS.end_date_help_text} />
          </div>
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Notice period (days)</label>
            <input type="number" min={0} max={90} className={inputCls}
              value={settings.cancellation_form?.notice_days ?? ''}
              placeholder={String(CF_DEFAULTS.notice_days)}
              onChange={e => setCancelForm('notice_days', e.target.value === '' ? null : Number(e.target.value))} />
            <p className="text-xs text-un1t-subtle mt-1">The earliest end date the member can pick is this many days from today.</p>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Review step text</label>
          <input className={inputCls} maxLength={500} value={settings.cancellation_form?.confirm_text || ''}
            onChange={e => setCancelForm('confirm_text', e.target.value)}
            placeholder={CF_DEFAULTS.confirm_text} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Thanks (cancellation submitted)</label>
            <textarea className={inputCls} rows={2} maxLength={500} value={settings.cancellation_form?.thanks_cancel_text || ''}
              onChange={e => setCancelForm('thanks_cancel_text', e.target.value)}
              placeholder={CF_DEFAULTS.thanks_cancel_text} />
          </div>
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Thanks (pause submitted)</label>
            <textarea className={inputCls} rows={2} maxLength={500} value={settings.cancellation_form?.thanks_pause_text || ''}
              onChange={e => setCancelForm('thanks_pause_text', e.target.value)}
              placeholder={CF_DEFAULTS.thanks_pause_text} />
          </div>
        </div>
      </div>

      <h3 className="text-sm font-semibold text-un1t-text mt-6 mb-2">Sending the link</h3>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Email subject</label>
          <input className={inputCls} maxLength={200} value={settings.cancellation_form?.email_subject || ''}
            onChange={e => setCancelForm('email_subject', e.target.value)}
            placeholder={CF_DEFAULTS.email_subject} />
        </div>
        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Email body (must include <code>{'{link}'}</code>)</label>
          <textarea className={inputCls} rows={5} maxLength={4000} value={settings.cancellation_form?.email_body || ''}
            onChange={e => setCancelForm('email_body', e.target.value)}
            placeholder={CF_DEFAULTS.email_body} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-un1t-text mb-1">WhatsApp message (the link becomes a tappable button)</label>
            <textarea className={inputCls} rows={3} maxLength={1024} value={settings.cancellation_form?.whatsapp_text || ''}
              onChange={e => setCancelForm('whatsapp_text', e.target.value)}
              placeholder={CF_DEFAULTS.whatsapp_text} />
          </div>
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Button label</label>
            <input className={inputCls} maxLength={20} value={settings.cancellation_form?.whatsapp_button_text || ''}
              onChange={e => setCancelForm('whatsapp_button_text', e.target.value)}
              placeholder={CF_DEFAULTS.whatsapp_button_text} />
            <p className="text-xs text-un1t-subtle mt-1">20 characters max (WhatsApp&apos;s limit).</p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Outside-window WhatsApp template</label>
            <select className={inputCls}
              value={settings.cancellation_form?.whatsapp_template_name || ''}
              onChange={e => setCancelForm('whatsapp_template_name', e.target.value || null)}>
              <option value="">None (send by WhatsApp only inside the 24h window)</option>
              {templates.map(t => (
                <option key={`${t.name}:${t.language}`} value={t.name}>{t.name} ({t.language})</option>
              ))}
            </select>
            <p className="text-xs text-un1t-subtle mt-1">
              An approved UTILITY template whose URL button ends in <code>{'{{1}}'}</code> (the link token) —
              lets staff send the form when the member has not messaged in 24 hours.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Link host (optional)</label>
            <input className={inputCls} maxLength={512} value={settings.cancellation_form?.public_base_url || ''}
              onChange={e => setCancelForm('public_base_url', e.target.value)}
              placeholder="Default: this CRM's address" />
            <p className="text-xs text-un1t-subtle mt-1">
              e.g. <code>https://un1tdublin.com</code> to hand members a link on the marketing site instead of the CRM address.
            </p>
          </div>
        </div>
      </div>

      <h3 className="text-sm font-semibold text-un1t-text mt-6 mb-2">After you decide</h3>
      <p className="text-xs text-un1t-muted mb-3">Sent to the member on the channel the link went out on (email, or the WhatsApp thread).</p>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Cancellation approved</label>
          <textarea className={inputCls} rows={2} maxLength={500} value={settings.cancellation_form?.cancel_confirmation_text || ''}
            onChange={e => setCancelForm('cancel_confirmation_text', e.target.value)}
            placeholder={CF_DEFAULTS.cancel_confirmation_text} />
        </div>
        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Pause approved</label>
          <textarea className={inputCls} rows={2} maxLength={500} value={settings.cancellation_form?.pause_confirmation_text || ''}
            onChange={e => setCancelForm('pause_confirmation_text', e.target.value)}
            placeholder={CF_DEFAULTS.pause_confirmation_text} />
        </div>
        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Marked as saved (member stays)</label>
          <textarea className={inputCls} rows={2} maxLength={500} value={settings.cancellation_form?.saved_confirmation_text || ''}
            onChange={e => setCancelForm('saved_confirmation_text', e.target.value)}
            placeholder={CF_DEFAULTS.saved_confirmation_text} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[['confirmation_template_cancel', 'Cancellation template'], ['confirmation_template_pause', 'Pause template'], ['confirmation_template_saved', 'Saved template']].map(([key, label]) => (
            <div key={key}>
              <label className="block text-sm font-medium text-un1t-text mb-1">{label} (WhatsApp, window closed)</label>
              <select className={inputCls}
                value={settings.cancellation_form?.[key] || ''}
                onChange={e => setCancelForm(key, e.target.value || null)}>
                <option value="">None</option>
                {templates.map(t => (
                  <option key={`${t.name}:${t.language}`} value={t.name}>{t.name} ({t.language})</option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <p className="text-xs text-un1t-subtle">
          A WhatsApp-delivered form rarely reopens the 24h window, so without a template the card tells you the member has not been told and you follow up yourself.
          Templates take <code>{'{{1}}'}</code> first name and <code>{'{{2}}'}</code> the date.
        </p>
      </div>
    </>
  )
}
