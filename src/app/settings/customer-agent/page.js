'use client'

import { useState, useEffect } from 'react'
import ConnectionsSection from '@/components/customer-agent/ConnectionsSection'
import Link from 'next/link'
import { BarChart3 } from 'lucide-react'

// RADAR-AGENT.0 — operator settings for the customer-facing WhatsApp /
// Instagram agent. Manager+ only. Three parts: (1) per-location channel
// Connections, (2) behaviour settings, (3) the knowledge editor the
// agent answers from. Ships OFF by default.

const CATEGORIES = ['sales', 'account', 'pause', 'cancellation', 'hours', 'general', 'faq']

export default function CustomerAgentSettingsPage() {
  const [settings, setSettings] = useState(null)
  const [location, setLocation] = useState(null)
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [sRes, kRes] = await Promise.all([
          fetch('/api/settings/customer-agent').then(r => r.json()),
          fetch('/api/agent/knowledge').then(r => r.json()),
        ])
        if (cancelled) return
        if (sRes.success) { setSettings(sRes.settings); setLocation(sRes.location || null) }
        if (kRes.success) setEntries(kRes.entries || [])
      } catch {
        if (!cancelled) setError('Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  function setField(k, v) { setSettings(s => ({ ...s, [k]: v })) }

  async function saveSettings() {
    setSaving(true); setError(null)
    try {
      const payload = {
        enabled: !!settings.enabled,
        test_mode: !!settings.test_mode,
        test_phones: (settings.test_phones || []),
        tone: settings.tone || null,
        extra_rules: settings.extra_rules || null,
        holding_message: settings.holding_message || null,
        quiet_hours: settings.quiet_hours?.start && settings.quiet_hours?.end
          ? { start: settings.quiet_hours.start, end: settings.quiet_hours.end, tz: settings.quiet_hours.tz || 'Europe/Dublin' }
          : null,
        booking_mode: settings.booking_mode === 'draft' ? 'draft' : 'auto',
        agent_name: (settings.agent_name || '').trim() || null,
        membership_signup_url: (settings.membership_signup_url || '').trim() || null,
        booking_url: (settings.booking_url || '').trim() || null,
        booking_cta_label: (settings.booking_cta_label || '').trim() || null,
        membership_cta_label: (settings.membership_cta_label || '').trim() || null,
        handoff_cooldown_hours: settings.handoff_cooldown_hours ?? 12,
        consultation_event_type_id: settings.consultation_event_type_id || null,
        followups: {
          enabled: !!settings.followups?.enabled,
          nudge_after_hours: Number(settings.followups?.nudge_after_hours) || 3,
          template_name: settings.followups?.template_name || null,
          daily_cap: Number(settings.followups?.daily_cap) || 50,
        },
        first_class_checkin: {
          enabled: !!settings.first_class_checkin?.enabled,
          delay_hours: Number(settings.first_class_checkin?.delay_hours) || 2,
          template_name: settings.first_class_checkin?.template_name || null,
          daily_cap: Number(settings.first_class_checkin?.daily_cap) || 20,
        },
      }
      const res = await fetch('/api/settings/customer-agent', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const j = await res.json()
      if (j.success) setSavedAt(Date.now()); else setError(j.error || 'Failed to save')
    } catch { setError('Failed to save') } finally { setSaving(false) }
  }

  // AGENT-FOLLOWUP.1 — approved templates for the stage-2 picker. The
  // template COPY lives in the WhatsApp Templates manager (edit &
  // resubmit there any time); this picker just selects which one the
  // follow-up uses — fully updatable without code.
  const [templates, setTemplates] = useState([])
  useEffect(() => {
    fetch('/api/whatsapp/templates')
      .then(r => r.json())
      .then(j => {
        const list = j.templates || j.data || []
        setTemplates(list.filter(t => String(t.status || '').toUpperCase() === 'APPROVED'))
      })
      .catch(() => {})
  }, [])
  const setFollowup = (key, value) =>
    setSettings(s => ({ ...s, followups: { ...(s.followups || {}), [key]: value } }))
  const setCheckin = (key, value) =>
    setSettings(s => ({ ...s, first_class_checkin: { ...(s.first_class_checkin || {}), [key]: value } }))

  const [importing, setImporting] = useState(false)
  const [importNote, setImportNote] = useState(null)

  // KNOWLEDGE-IMPORT.1 — one click pulls the Glofox timetable's class
  // types + descriptions into knowledge. Existing titles are never
  // overwritten, so re-running after adding a class is safe.
  async function importFromGlofox() {
    setImporting(true); setError(null); setImportNote(null)
    try {
      const res = await fetch('/api/agent/knowledge/import-classes', { method: 'POST' })
      const j = await res.json()
      if (!j.success) { setError(j.error || 'Import failed'); return }
      if (j.imported?.length) setEntries(e => [...e, ...j.imported])
      const bits = []
      bits.push(`${j.imported?.length || 0} class${(j.imported?.length || 0) === 1 ? '' : 'es'} imported`)
      if (j.skipped?.length) bits.push(`${j.skipped.length} already in knowledge`)
      if (j.missing_description?.length) bits.push(`no Glofox description for: ${j.missing_description.join(', ')} (added as drafts — fill them in below)`)
      setImportNote(j.message || bits.join(' · '))
    } catch { setError('Import failed') } finally { setImporting(false) }
  }

  async function addEntry() {
    setError(null)
    try {
      const res = await fetch('/api/agent/knowledge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: 'sales', title: 'New entry', content: '', enabled: true }),
      })
      const j = await res.json()
      if (j.success) setEntries(e => [...e, j.entry])
      else setError(j.error || 'Could not add the entry')
    } catch { setError('Could not add the entry') }
  }
  function editLocal(id, patch) {
    setEntries(e => e.map(x => x.id === id ? { ...x, ...patch } : x))
  }
  async function persist(id, patch) {
    editLocal(id, patch)
    try {
      const res = await fetch(`/api/agent/knowledge/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      const j = await res.json()
      if (!j.success) setError(j.error || 'Could not save the entry')
    } catch { setError('Could not save the entry') }
  }
  async function deleteEntry(id) {
    setEntries(e => e.filter(x => x.id !== id))
    await fetch(`/api/agent/knowledge/${id}`, { method: 'DELETE' })
  }

  if (loading || !settings) return <div className="p-6 text-sm text-un1t-muted">Loading…</div>

  const inputCls = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text'

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-bold text-un1t-text mb-1">Customer Agent</h1>
      <p className="text-sm text-un1t-muted mb-6">
        The AI assistant that answers customers on WhatsApp and Instagram. It only
        answers from the knowledge below and hands off to a human for anything it can&apos;t answer.
        Ships off by default — use Test mode to trial it on your own number first.
      </p>

      <Link
        href="/settings/customer-agent/analytics"
        className="inline-flex items-center gap-2 text-sm bg-un1t-surface border border-un1t-border rounded-lg px-4 py-2.5 mb-6 hover:border-un1t-subtle transition-colors"
      >
        <BarChart3 size={16} className="text-un1t-accent" />
        <span className="text-un1t-text">View agent activity</span>
        <span className="text-un1t-muted">— replies, escalations, what customers asked</span>
      </Link>

      {location?.id && <ConnectionsSection locationId={location.id} locationName={location.name} />}

      {/* ── Behaviour ─────────────────────────────────────── */}
      <section className="space-y-5 border border-un1t-border rounded-lg p-5 mb-6">
        <label className="flex items-center gap-3">
          <input type="checkbox" className="h-4 w-4" checked={!!settings.enabled}
            onChange={e => setField('enabled', e.target.checked)} />
          <span className="text-sm text-un1t-text font-medium">Live — reply to all customers</span>
        </label>

        <div className="pl-7 space-y-3 border-l border-un1t-border ml-1">
          <label className="flex items-center gap-3">
            <input type="checkbox" className="h-4 w-4" checked={!!settings.test_mode}
              onChange={e => setField('test_mode', e.target.checked)} />
            <span className="text-sm text-un1t-text">Test mode — reply only to the numbers below (while not live)</span>
          </label>
          <div>
            <label className="block text-xs text-un1t-muted mb-1">Test numbers (comma-separated, e.g. +353871234567)</label>
            <input className={inputCls} value={(settings.test_phones || []).join(', ')}
              onChange={e => setField('test_phones', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
              placeholder="+353871234567, +353879999999" />
          </div>
        </div>

        {/* AGENT-HANDS.1 — class-booking autonomy. Consultations for
            new leads are always autonomous; this controls member
            CLASS bookings only. */}
        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Class bookings</label>
          <select className={inputCls} value={settings.booking_mode === 'draft' ? 'draft' : 'auto'}
            onChange={e => setField('booking_mode', e.target.value)}>
            <option value="auto">Book immediately (agent books verified members straight in)</option>
            <option value="draft">Queue for approval (one tap in Approvals books it + confirms to the member)</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Hand back to the agent after (hours)</label>
          <input type="number" min={0} max={168} className={inputCls}
            value={settings.handoff_cooldown_hours ?? 12}
            onChange={e => setField('handoff_cooldown_hours', e.target.value === '' ? null : Number(e.target.value))} />
          <p className="text-xs text-un1t-subtle mt-1">
            After the agent hands a conversation to a human, it stays out of that thread until a staff member
            resolves it in the inbox (which hands it straight back) — or until this many hours pass. 0 = only a
            resolve brings the agent back.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Agent name</label>
          <input className={inputCls} maxLength={40} value={settings.agent_name || ''}
            onChange={e => setField('agent_name', e.target.value)}
            placeholder="Mia" />
          <p className="text-xs text-un1t-subtle mt-1">
            The agent introduces itself by this name as the studio&apos;s AI assistant on first contact
            (Meta&apos;s AI-messaging rules require the disclosure).
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Membership sign-up link</label>
          <input className={inputCls} maxLength={512} value={settings.membership_signup_url || ''}
            onChange={e => setField('membership_signup_url', e.target.value)}
            placeholder="https://…" />
          <p className="text-xs text-un1t-subtle mt-1">
            Shared when someone wants to join — sign-up and payment happen on this page. Update it
            here any time (offers, new landing pages); leave blank and the agent hands membership
            sign-ups to the team instead.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Class booking link</label>
          <input className={inputCls} maxLength={512} value={settings.booking_url || ''}
            onChange={e => setField('booking_url', e.target.value)}
            placeholder="https://…" />
          <p className="text-xs text-un1t-subtle mt-1">
            Where active members go to book their next class — used by the post-class report CTA. Leave blank and members see no booking button.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Post-class CTA wording</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input className={inputCls} maxLength={60} value={settings.booking_cta_label || ''}
              onChange={e => setField('booking_cta_label', e.target.value)}
              placeholder="Book your next class" />
            <input className={inputCls} maxLength={60} value={settings.membership_cta_label || ''}
              onChange={e => setField('membership_cta_label', e.target.value)}
              placeholder="Become a member" />
          </div>
          <p className="text-xs text-un1t-subtle mt-1">
            Button text shown to members (left, booking) and to trials / prospects (right, join). Leave blank to use the defaults shown.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Tone &amp; voice</label>
          <textarea className={inputCls} rows={2} maxLength={2000} value={settings.tone || ''}
            onChange={e => setField('tone', e.target.value)}
            placeholder="e.g. Warm, upbeat, brief. Use first names. No emojis." />
        </div>

        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Extra rules (optional)</label>
          <textarea className={inputCls} rows={2} maxLength={2000} value={settings.extra_rules || ''}
            onChange={e => setField('extra_rules', e.target.value)}
            placeholder="e.g. Never discuss competitor pricing." />
        </div>

        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Hand-off message</label>
          <input className={inputCls} maxLength={500} value={settings.holding_message || ''}
            onChange={e => setField('holding_message', e.target.value)}
            placeholder="Thanks! One of the UN1T team will get back to you shortly." />
          <p className="text-xs text-un1t-muted mt-1">Sent to the customer when the agent hands the chat to a human.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Quiet hours (optional)</label>
          <div className="flex items-center gap-2 text-sm">
            <input type="time" className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-un1t-text"
              value={settings.quiet_hours?.start || ''}
              onChange={e => setField('quiet_hours', { ...(settings.quiet_hours || {}), start: e.target.value })} />
            <span className="text-un1t-muted">to</span>
            <input type="time" className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-un1t-text"
              value={settings.quiet_hours?.end || ''}
              onChange={e => setField('quiet_hours', { ...(settings.quiet_hours || {}), end: e.target.value })} />
            <span className="text-xs text-un1t-muted">Europe/Dublin — agent stays quiet, a human replies.</span>
          </div>
        </div>

        {error && <div className="text-sm text-red-600">{error}</div>}
        <div>
          <button onClick={saveSettings} disabled={saving}
            className="bg-un1t-text text-un1t-bg px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50">
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          {savedAt && <span className="ml-3 text-sm text-green-600">Saved ✓</span>}
        </div>
      </section>

      {/* ── Proactive follow-ups (AGENT-FOLLOWUP.1) ───────── */}
      <section className="border border-un1t-border rounded-lg p-5 mt-6">
        <h2 className="text-base font-semibold text-un1t-text mb-1">Proactive follow-ups</h2>
        <p className="text-sm text-un1t-muted mb-4">
          When someone goes quiet on an open request, the agent sends one gentle in-window nudge,
          then (if they stay quiet past WhatsApp&apos;s 24-hour window) one approved template inviting
          a reply. A reply re-opens the window and the agent picks the conversation back up.
        </p>
        <label className="flex items-center gap-2 text-sm text-un1t-text mb-4">
          <input type="checkbox" checked={!!settings.followups?.enabled}
            onChange={e => setFollowup('enabled', e.target.checked)} />
          Enable proactive follow-ups
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Nudge after (hours)</label>
            <input type="number" min={1} max={18} className={inputCls}
              value={settings.followups?.nudge_after_hours ?? 3}
              onChange={e => setFollowup('nudge_after_hours', e.target.value === '' ? 3 : Number(e.target.value))} />
            <p className="text-xs text-un1t-subtle mt-1">How long they&apos;re quiet before the in-window nudge (sent up to 20h after, daytime only).</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Outside-window template</label>
            <select className={inputCls}
              value={settings.followups?.template_name || ''}
              onChange={e => setFollowup('template_name', e.target.value || null)}>
              <option value="">— none (in-window nudge only) —</option>
              {templates.map(t => (
                <option key={`${t.name}:${t.language}`} value={t.name}>{t.name} ({t.language})</option>
              ))}
            </select>
            <p className="text-xs text-un1t-subtle mt-1">
              Approved templates only. Edit the wording in WhatsApp → Templates and re-select here —
              variables: {'{{1}}'} first name, {'{{2}}'} topic. Marketing consent is required and enforced.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Daily cap (per studio)</label>
            <input type="number" min={1} max={500} className={inputCls}
              value={settings.followups?.daily_cap ?? 50}
              onChange={e => setFollowup('daily_cap', e.target.value === '' ? 50 : Number(e.target.value))} />
            <p className="text-xs text-un1t-subtle mt-1">Hard ceiling on proactive sends per day.</p>
          </div>
        </div>
      </section>

      {/* ── First-class check-in (AGENT-CHECKIN.1) ────────── */}
      <section className="border border-un1t-border rounded-lg p-5 mt-6">
        <h2 className="text-base font-semibold text-un1t-text mb-1">First-class check-in</h2>
        <p className="text-sm text-un1t-muted mb-4">
          After a new lead or trial member attends their first class, the agent checks in once —
          free-form when they have an open chat window (e.g. they booked through the agent), or via
          the approved template below otherwise. Good replies get offered their next booking;
          complaints hand off to the team immediately.
        </p>
        <label className="flex items-center gap-2 text-sm text-un1t-text mb-4">
          <input type="checkbox" checked={!!settings.first_class_checkin?.enabled}
            onChange={e => setCheckin('enabled', e.target.checked)} />
          Enable first-class check-ins
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Send after (hours)</label>
            <input type="number" min={1} max={24} className={inputCls}
              value={settings.first_class_checkin?.delay_hours ?? 2}
              onChange={e => setCheckin('delay_hours', e.target.value === '' ? 2 : Number(e.target.value))} />
            <p className="text-xs text-un1t-subtle mt-1">Hours after the class before the check-in (daytime only; evening classes roll to next morning).</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Check-in template</label>
            <select className={inputCls}
              value={settings.first_class_checkin?.template_name || ''}
              onChange={e => setCheckin('template_name', e.target.value || null)}>
              <option value="">— none (open-window check-ins only) —</option>
              {templates.map(t => (
                <option key={`fcc:${t.name}:${t.language}`} value={t.name}>{t.name} ({t.language})</option>
              ))}
            </select>
            <p className="text-xs text-un1t-subtle mt-1">
              Used when they have no open chat window. Variables: {'{{1}}'} first name, {'{{2}}'} class name.
              Marketing consent required and enforced.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Daily cap (per studio)</label>
            <input type="number" min={1} max={200} className={inputCls}
              value={settings.first_class_checkin?.daily_cap ?? 20}
              onChange={e => setCheckin('daily_cap', e.target.value === '' ? 20 : Number(e.target.value))} />
            <p className="text-xs text-un1t-subtle mt-1">Each contact only ever gets one check-in.</p>
          </div>
        </div>
      </section>

      {/* ── Knowledge ─────────────────────────────────────── */}
      <section className="border border-un1t-border rounded-lg p-5 mt-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-base font-semibold text-un1t-text">Knowledge</h2>
          <div className="flex items-center gap-2">
            <button type="button" onClick={importFromGlofox} disabled={importing}
              className="text-sm border border-un1t-border rounded-md px-3 py-1.5 text-un1t-text hover:bg-un1t-bg disabled:opacity-50">
              {importing ? 'Importing…' : 'Import classes from Glofox'}
            </button>
            <button type="button" onClick={addEntry}
              className="text-sm border border-un1t-border rounded-md px-3 py-1.5 text-un1t-text hover:bg-un1t-bg">
              + Add entry
            </button>
          </div>
        </div>
        <p className="text-sm text-un1t-muted mb-4">
          The facts the agent is allowed to use — prices, offers, policies, FAQs. If it isn&apos;t here,
          the agent hands off instead of guessing.
        </p>
        {importNote && <p className="text-sm text-emerald-700 mb-3">{importNote}</p>}

        {entries.length === 0 && (
          <div className="text-sm text-un1t-muted border border-dashed border-un1t-border rounded-md p-4">
            No knowledge yet. Add your prices, trial offer, opening hours, and common questions.
          </div>
        )}

        <div className="space-y-3">
          {entries.map(entry => (
            <div key={entry.id} className="border border-un1t-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <select value={entry.category}
                  onChange={e => persist(entry.id, { category: e.target.value })}
                  className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-xs text-un1t-text">
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <input className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-sm text-un1t-text"
                  value={entry.title}
                  onChange={e => editLocal(entry.id, { title: e.target.value })}
                  onBlur={e => persist(entry.id, { title: e.target.value })}
                  placeholder="Short title" maxLength={200} />
                <label className="flex items-center gap-1 text-xs text-un1t-muted">
                  <input type="checkbox" checked={!!entry.enabled}
                    onChange={e => persist(entry.id, { enabled: e.target.checked })} />
                  on
                </label>
                <button onClick={() => deleteEntry(entry.id)}
                  className="text-xs text-red-600 hover:underline">Delete</button>
              </div>
              <textarea className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
                rows={2} maxLength={4000} value={entry.content}
                onChange={e => editLocal(entry.id, { content: e.target.value })}
                onBlur={e => persist(entry.id, { content: e.target.value })}
                placeholder="The answer / fact, in plain language." />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
