'use client'

// MIASETTINGS.2c — Overview: Mia's Off / Test / Live switch and quiet hours.
// The switch sits straight in the section (no source tag: enabled and
// test_mode are studio-only).

import StatusSwitch from '../components/StatusSwitch'
import FieldLabel from '../components/FieldLabel'
import { flagsFor } from '../status'
import { CARD } from './field-renderer'

export default function OverviewSection({ agent, canEdit }) {
  const { settings, location, setField, setQuietHours, setNoQuietHours, sourceTag, holds } = agent
  const noQuietHours = settings?.quiet_hours?.off === true
  // MIAORG.1 Task 4 — one end of the window only holds Save ("Set both times").
  const quietHalf = holds.some((h) => h.section === 'overview')
  return (
    <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0">
      <section className={`space-y-5 ${CARD}`}>
        {/* MIAORG.1 Task 3 — what the source tags mean (staff copy). */}
        <p className="text-xs text-un1t-muted">
          A field tagged Organisation default or Default follows your organisation&apos;s setting, or the
          built-in default, until you change it here. Changing it sets it for this studio only.
          Use organisation default puts it back.
        </p>
        {/* MIASETTINGS.2b — one Off / Test / Live switch over enabled + test_mode.
            Choosing never touches test_phones. */}
        <StatusSwitch settings={settings}
          onChoose={(choice) => { const f = flagsFor(choice); setField('enabled', f.enabled); setField('test_mode', f.test_mode) }}
          onTestPhones={(list) => setField('test_phones', list)} />

        <div>
          <FieldLabel tag={sourceTag(['quiet_hours'])}>Quiet hours (optional)</FieldLabel>
          <div className="flex items-center gap-2 text-sm">
            <input type="time" className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-un1t-text"
              aria-label="Quiet hours start" disabled={noQuietHours}
              value={settings.quiet_hours?.start || ''}
              onChange={e => setQuietHours('start', e.target.value)} />
            <span className="text-un1t-muted">to</span>
            <input type="time" className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-un1t-text"
              aria-label="Quiet hours end" disabled={noQuietHours}
              value={settings.quiet_hours?.end || ''}
              onChange={e => setQuietHours('end', e.target.value)} />
            <span className="text-xs text-un1t-muted">{settings.quiet_hours?.tz || location?.timezone || "the studio's timezone"} — agent stays quiet, a human replies.</span>
          </div>
          {quietHalf && <p className="text-xs text-red-600 mt-1" role="alert">Set both times</p>}
          <label className="flex items-center gap-2 text-sm text-un1t-text mt-2">
            <input type="checkbox" className="h-4 w-4" checked={noQuietHours}
              onChange={e => setNoQuietHours(e.target.checked)} />
            No quiet hours (ignore the organisation&apos;s)
          </label>
        </div>
      </section>
    </fieldset>
  )
}
