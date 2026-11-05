'use client'

// MIASETTINGS.2c — Follow-ups: proactive follow-ups, the first-class
// check-in (with its live stats), the trial finisher at a un1t.online studio
// and the inline suggestion after approvals. Moved from CustomerAgentClient;
// the two template pickers take their label, help and empty option from the
// registry (fields.js), and the card intros lose their dashes.

import { useState } from 'react'
import { zoneCity } from '@/lib/record-time'
import { TRIAL_DONE_MIA_INSTRUCTION_DEFAULT } from '@/lib/agent/settings-overrides'
import { trialDoneErrors, parseTrialDoneContactIds } from '../save-payload'
import FieldLabel from '../components/FieldLabel'
import { CARD, inputCls, registryField } from './field-renderer'

// AGENT-CHECKIN.2 — humanise the last tick's skip-reason tally.
function describeCheckinReasons(checkins) {
  const reasons = checkins?.reasons || {}
  const parts = Object.entries(reasons).map(([k, n]) => `${k.replace(/_/g, ' ')} ×${n}`)
  if (checkins?.reason === 'quiet_hours') parts.unshift('quiet hours')
  return parts.length ? ` (${parts.join(', ')})` : ''
}

// CHECKINSTALL.1 — one line per Dublin day from last_outcome.checkins_day.
// Counts are per 15-minute run, not per person (one lead skipped all
// afternoon shows ×20). Staff copy, not customer-facing.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function describeCheckinDay(d) {
  if (!d?.day) return null
  const [, mm, dd] = d.day.split('-')
  const label = `${Number(dd)} ${MONTHS[Number(mm) - 1] || ''}`
  const sent = (d.freeform || 0) + (d.templates || 0)
  const runs = d.daytime_ticks || 0
  const checks = d.candidates || 0
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
  const failed = d.failed_ticks ? ` · ${plural(d.failed_ticks, 'failed run')}` : ''
  const partial = d.carry_failed ? ' (partial: an earlier run could not be read)' : ''
  return `${label}: ${plural(runs, 'daytime run')} · ${plural(checks, 'candidate check')} · ${sent} sent · ${d.skipped || 0} skipped${describeCheckinReasons({ reasons: d.reasons })}${failed}${partial}`
}

// AGENT-FOLLOWUP.1 — a picker of this studio's approved templates. The
// template COPY lives in the WhatsApp Templates manager; this selects which
// one is used.
function TemplatePicker({ field, value, onChange, templates, tag, keyPrefix = '' }) {
  return (
    <div>
      <FieldLabel tag={tag}>{field.label}</FieldLabel>
      <select className={inputCls} value={value || ''} onChange={e => onChange(e.target.value || null)}>
        <option value="">{field.noneLabel}</option>
        {templates.map(t => (
          <option key={`${keyPrefix}${t.name}:${t.language}`} value={t.name}>{t.name} ({t.language})</option>
        ))}
      </select>
      {field.help && <p className="text-xs text-un1t-subtle mt-1">{field.help}</p>}
    </div>
  )
}


// MIASETTINGS.3b — a card whose details fold away while its switch is off.
// The details are not rendered then, but the values stay in state and still
// save. "Show settings" opens them without switching the feature on; turning
// the switch on shows them. `forceOpen` keeps an invalid field in view.
function FoldCard({ title, intro, header, on, forceOpen = false, always = null, testId, children }) {
  const [shown, setShown] = useState(false)
  const open = on || shown || forceOpen
  return (
    <section className={CARD} data-testid={testId}>
      <h3 className="text-base font-semibold text-un1t-text mb-1">{title}</h3>
      <p className="text-sm text-un1t-muted mb-4">{intro}</p>
      <div className="mb-4">{header}</div>
      {always}
      {open ? children : (
        <button type="button" aria-expanded={false} onClick={() => setShown(true)}
          className="text-sm text-un1t-muted hover:text-un1t-text underline">
          Show settings
        </button>
      )}
    </section>
  )
}

export default function FollowupsSection({ agent, renderField, canEdit }) {
  const { settings, setField, sourceTag, templates, checkinStats, location, membershipSourceKey, ctx } = agent
  const followupTemplate = registryField('followups.template_name', ctx)
  const checkinTemplate = registryField('first_class_checkin.template_name', ctx)
  // TRIALDONE.3 — the trial finisher is studio-only and a un1t.online studio only.
  const showTrialDone = membershipSourceKey === 'un1t_online'
  const trialErrors = showTrialDone ? trialDoneErrors(settings) : {}
  const setTrialDone = (key, value) => setField(`trial_done.${key}`, value)

  return (
    <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0 space-y-6">
      {/* ── Proactive follow-ups (AGENT-FOLLOWUP.1) ───────── */}
      <FoldCard title="Proactive follow-ups" on={!!settings.followups?.enabled}
        header={renderField('followups.enabled')}
        intro={<>
          When someone goes quiet on an open request, the agent sends one gentle in-window nudge,
          then (if they stay quiet past WhatsApp&apos;s 24-hour window) one approved template inviting
          a reply. A reply re-opens the window and the agent picks the conversation back up.
        </>}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {renderField('followups.nudge_after_hours')}
          <TemplatePicker field={followupTemplate} value={settings.followups?.template_name}
            onChange={(v) => setField('followups.template_name', v)} templates={templates}
            tag={sourceTag(['followups.template_name'])} />
          {renderField('followups.daily_cap')}
        </div>
      </FoldCard>

      {/* ── First-class check-in (AGENT-CHECKIN.1) ────────── */}
      <FoldCard title="First-class check-in" on={!!settings.first_class_checkin?.enabled}
        header={renderField('first_class_checkin.enabled')}
        intro={<>
          After a new lead or trial member attends their first class, the agent checks in once:
          free-form when they have an open chat window (e.g. they booked through the agent), or via
          the approved template below otherwise. Good replies get offered their next booking;
          complaints hand off to the team immediately.
        </>}
        always={(checkinStats && (
          <div className="mb-4 rounded-md border border-un1t-border bg-un1t-bg/40 px-3 py-2 text-xs text-un1t-subtle space-y-1">
            <p>
              {/* CHECKINRISKS.1 — both counts are SENDS (the cap's own counter);
                  null means the read failed, which is never shown as 0. */}
              <span className="font-semibold text-un1t-text">
                {checkinStats.sent_today == null
                  ? 'Sent today: could not be read'
                  : `Sent today ${checkinStats.sent_today}/${settings.first_class_checkin?.daily_cap ?? 20}`}
              </span>
              {' · '}Sent all time {checkinStats.total == null ? 'could not be read' : checkinStats.total}
              {' · '}Last:{' '}
              {checkinStats.last_unreadable
                ? 'could not be read'
                : checkinStats.last
                  ? `${checkinStats.last.contact_name || 'contact'} — ${checkinStats.last.note || 'sent'} (${new Date(checkinStats.last.at).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })})`
                  : 'none yet'}
            </p>
            {checkinStats.last_run && (
              <p>
                Last run {new Date(checkinStats.last_run.at).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })}
                {checkinStats.last_run.checkins
                  ? ` — ${(checkinStats.last_run.checkins.freeform || 0) + (checkinStats.last_run.checkins.templates || 0)} sent · ${checkinStats.last_run.checkins.skipped || 0} skipped${describeCheckinReasons(checkinStats.last_run.checkins)}`
                  // TZ.16 — the window is the studio's own clock (TZ.5): name its zone.
                  : ` — no check-in summary yet (runs every 15 min, 9:00–20:00 ${location?.timezone ? zoneCity(location.timezone) : 'studio time'})`}
              </p>
            )}
            {checkinStats.last_run?.day && (
              <p>{describeCheckinDay(checkinStats.last_run.day)}</p>
            )}
            {checkinStats.last_run?.day?.previous && (
              <p>{describeCheckinDay(checkinStats.last_run.day.previous)}</p>
            )}
          </div>
        ))}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {renderField('first_class_checkin.delay_hours')}
          <TemplatePicker field={checkinTemplate} value={settings.first_class_checkin?.template_name}
            onChange={(v) => setField('first_class_checkin.template_name', v)} templates={templates}
            tag={sourceTag(['first_class_checkin.template_name'])} keyPrefix="fcc:" />
          {renderField('first_class_checkin.daily_cap')}
        </div>
      </FoldCard>

      {/* ── Trial finisher follow-up (TRIALDONE.3) ────────────
          Studio-only (an organisation can never switch it on) and shown only
          at a un1t.online studio (Hatch Street). After a trial member's last
          class the studio sends the opener template below; a reply goes to
          Mia, briefed by the instruction. Off by default. A list of test
          contacts makes it a test: nobody else is messaged. */}
      {showTrialDone && settings.trial_done && (() => {
        const td = settings.trial_done
        const idsText = td.only_contact_ids_text ?? (Array.isArray(td.only_contact_ids) ? td.only_contact_ids : []).join('\n')
        const testCount = parseTrialDoneContactIds(idsText).length
        return (
          <FoldCard title="Trial finisher follow-up" testId="trial-done-card" on={!!td.enabled}
            forceOpen={Object.keys(trialErrors).length > 0}
            intro={<>
              After a trial member has done 3 trial classes, or 2 classes and the trial has expired, the studio
              sends them the opener template below. If they reply, Mia helps them choose between a membership and a class pack
              and sends the payment link. A second message follows if they stay quiet.
            </>}
            header={(
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm text-un1t-text">
                <input type="checkbox" checked={!!td.enabled}
                  onChange={e => setTrialDone('enabled', e.target.checked)} />
                Enable trial finisher follow-up
              </label>
              {testCount > 0 && (
                <span className="text-[11px] rounded-full bg-amber-500/10 text-amber-700 px-2 py-0.5 whitespace-nowrap">
                  {`Test: ${testCount} contact${testCount === 1 ? '' : 's'} only`}
                </span>
              )}
            </div>
            )}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <FieldLabel>Opener template</FieldLabel>
                <input className={inputCls} maxLength={512} aria-label="Opener template"
                  value={td.opener_template ?? ''}
                  aria-invalid={trialErrors.opener_template ? 'true' : undefined}
                  onChange={e => setTrialDone('opener_template', e.target.value)} />
                {trialErrors.opener_template
                  ? <p className="text-xs text-red-600 mt-1" role="alert">{trialErrors.opener_template}</p>
                  : <p className="text-xs text-un1t-subtle mt-1">The approved WhatsApp template name sent first. Variables: {'{{1}}'} first name.</p>}
              </div>
              <div>
                <FieldLabel>Follow-up template</FieldLabel>
                <input className={inputCls} maxLength={512} aria-label="Follow-up template"
                  value={td.followup_template ?? ''}
                  aria-invalid={trialErrors.followup_template ? 'true' : undefined}
                  onChange={e => setTrialDone('followup_template', e.target.value)} />
                {trialErrors.followup_template
                  ? <p className="text-xs text-red-600 mt-1" role="alert">{trialErrors.followup_template}</p>
                  : <p className="text-xs text-un1t-subtle mt-1">The approved template name sent once if they have not replied.</p>}
              </div>
              <div>
                <FieldLabel>Send after (hours)</FieldLabel>
                <input type="number" min={1} max={72} className={inputCls} aria-label="Send after (hours)"
                  value={td.delay_hours ?? ''}
                  placeholder="2"
                  aria-invalid={trialErrors.delay_hours ? 'true' : undefined}
                  onChange={e => setTrialDone('delay_hours', e.target.value === '' ? null : Number(e.target.value))} />
                {trialErrors.delay_hours
                  ? <p className="text-xs text-red-600 mt-1" role="alert">{trialErrors.delay_hours}</p>
                  : <p className="text-xs text-un1t-subtle mt-1">Hours after the trial ends before the opener goes out.</p>}
              </div>
            </div>
            <div className="mt-4">
              <FieldLabel>Mia&apos;s instruction</FieldLabel>
              <textarea className={inputCls} rows={4} aria-label="Mia's instruction"
                value={td.mia_instruction ?? ''}
                placeholder={TRIAL_DONE_MIA_INSTRUCTION_DEFAULT}
                aria-invalid={trialErrors.mia_instruction ? 'true' : undefined}
                onChange={e => setTrialDone('mia_instruction', e.target.value)} />
              {trialErrors.mia_instruction
                ? <p className="text-xs text-red-600 mt-1" role="alert">{trialErrors.mia_instruction}</p>
                : <p className="text-xs text-un1t-subtle mt-1">What Mia is told when a trial finisher replies. Leave blank for the default shown. Placeholders: {'{studio}'} {'{date}'}. No em-dashes.</p>}
            </div>
            <div className="mt-4">
              <FieldLabel>Test contact ids</FieldLabel>
              <textarea className={inputCls} rows={2} aria-label="Test contact ids"
                value={idsText}
                aria-invalid={trialErrors.only_contact_ids ? 'true' : undefined}
                onChange={e => setTrialDone('only_contact_ids_text', e.target.value)} />
              {trialErrors.only_contact_ids
                ? <p className="text-xs text-red-600 mt-1" role="alert">{trialErrors.only_contact_ids}</p>
                : <p className="text-xs text-un1t-subtle mt-1">
                    Up to 20 contact ids, one per line. While this list has anyone in it, ONLY those contacts are messaged: use it to test before clearing it to go live for everyone.
                  </p>}
            </div>
          </FoldCard>
        )
      })()}

      {/* ── Inline suggestion after approvals (INBOX-APPROVALS-AI.4) ── */}
      <section className={CARD}>
        <h3 className="text-base font-semibold text-un1t-text mb-1">Inline suggestion after approvals</h3>
        <p className="text-sm text-un1t-muted mb-4">
          After staff decide a request in the inbox, Mia drafts a suggested follow-up they can send.
        </p>
        {renderField('inline_suggestion.enabled')}
      </section>
    </fieldset>
  )
}
