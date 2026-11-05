'use client'
// MIASETTINGS.2b — one Off / Test / Live switch for Mia. Native radios, so it
// is keyboard-usable and greys out inside the page's disabled fieldset. The
// choice rides onClick, not onChange: on a live-and-test row Live already looks
// selected, and clicking it must still tidy the flags (onChange never fires
// for an already-checked radio; arrow keys also arrive as clicks).
import { statusOf } from '../status'

const OPTIONS = [
  { value: 'off', label: 'Off', help: 'Mia does not reply to anyone.' },
  { value: 'test', label: 'Test', help: 'Mia replies only to the test numbers below.' },
  { value: 'live', label: 'Live', help: 'Mia replies to every customer.' },
]

const inputCls = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text'

export default function StatusSwitch({ settings, onChoose, onTestPhones, disabled = false }) {
  const status = statusOf(settings)
  const selected = status === 'live_and_test' ? 'live' : status
  const help = OPTIONS.find(o => o.value === selected)?.help
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Mia is" className="inline-flex rounded-md border border-un1t-border overflow-hidden">
        {OPTIONS.map(o => (
          <label key={o.value}
            className={`cursor-pointer px-4 py-2 text-sm font-medium border-r border-un1t-border last:border-r-0 focus-within:ring-2 focus-within:ring-un1t-accent ${selected === o.value ? 'bg-un1t-text text-un1t-bg' : 'bg-un1t-surface text-un1t-text'} ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
            <input type="radio" name="mia-status" className="sr-only" value={o.value}
              checked={selected === o.value} disabled={disabled}
              onChange={() => {}}
              onClick={() => onChoose(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
      <p className="text-xs text-un1t-muted">{help}</p>
      {status === 'live_and_test' && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
          Live is on, so the test numbers are not being used: Mia is replying to every customer. Click Live to tidy this up.
        </div>
      )}
      {status === 'test' && (
        <div>
          <label className="block text-xs text-un1t-muted mb-1">Test numbers (comma-separated, e.g. +353871234567)</label>
          <input className={inputCls} value={(settings.test_phones || []).join(', ')}
            onChange={e => onTestPhones(e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
            placeholder="+353871234567, +353879999999" />
        </div>
      )}
    </div>
  )
}
