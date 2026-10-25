'use client'

// WA-MULTI.1 — WhatsApp tab for one studio.
//
// WAORGNUMBER.1: a number belongs to the ORGANISATION and is added, edited and
// removed in the hub's "WhatsApp numbers" drawer (organisation admins). This
// tab lists the organisation's numbers with a per-studio on/off switch and a
// default radio (StudioWhatsAppNumbers) and links to that drawer; the
// studio-level controls (chat openers, studio picker, card sets) stay.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Plus, Trash2, Loader2, CheckCircle2, AlertCircle,
  Pencil, Upload,
} from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { validateTemplateMedia } from '@/lib/template-media'
import { normalizeUrlish } from '@/lib/urlish'
import { orgNumbersHref } from '@/lib/org-whatsapp-numbers-page'
import { Row } from './WhatsAppFieldRow'
import StudioWhatsAppNumbers from '@/components/settings/whatsapp/StudioWhatsAppNumbers'
import PurposeTemplatesCard from '@/components/settings/whatsapp/PurposeTemplatesCard'
import ConsentCopyCard from '@/components/settings/whatsapp/ConsentCopyCard'

export default function WhatsAppIntegrationTab({ location, canEdit, canManageNumbers = false, canSwitch = false, onChanged }) {
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-un1t-text mb-1">WhatsApp numbers</h4>
        <p className="text-xs text-un1t-subtle">
          WhatsApp numbers belong to the organisation. Switch on the ones this location uses; the
          number marked <span className="font-medium">default</span> is the one outbound sends from
          broadcasts, sequences, and the inbox route through here. Inbound webhooks land at whichever
          number Meta posted to.
        </p>
        <p className="text-xs text-un1t-subtle mt-1">
          {canManageNumbers ? (
            <>
              Add, edit or remove numbers on{' '}
              <Link href={orgNumbersHref(location.organization_id)} className="text-blue-700 hover:underline">WhatsApp numbers</Link>.
            </>
          ) : (
            'An organisation admin adds, edits and removes numbers.'
          )}
        </p>
      </div>

      <StudioWhatsAppNumbers locationId={location.id} canSwitch={canSwitch} canManageNumbers={canManageNumbers} onChanged={onChanged} />

      <PurposeTemplatesCard locationId={location.id} canEdit={canEdit} />

      <ConsentCopyCard locationId={location.id} canEdit={canEdit} />

      <ChatOpenersCard location={location} canEdit={canEdit} />

      <StudioPickerCard location={location} canEdit={canEdit} />

      <CardSetsCard location={location} canEdit={canEdit} />
    </div>
  )
}

// C2 — Meta conversational components ("chat openers"): the welcome-message
// event (fires the request_welcome webhook → instant greeting) plus up to 4
// ice-breaker prompts shown to users opening a fresh chat with this number.
function ChatOpenersCard({ location, canEdit }) {
  const saved = location.settings?.conversational_automation || null
  const [enableWelcome, setEnableWelcome] = useState(saved ? saved.enable_welcome !== false : true)
  const [prompts, setPrompts] = useState(() => {
    const p = Array.isArray(saved?.prompts) ? saved.prompts : []
    return [p[0] || '', p[1] || '', p[2] || '', p[3] || '']
  })
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState(null)

  async function save() {
    setSaving(true); setError(null); setSavedAt(null)
    try {
      const res = await fetch('/api/whatsapp/conversational-automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: location.id,
          enable_welcome: enableWelcome,
          prompts: prompts.map((p) => p.trim()).filter(Boolean),
        }),
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to save chat openers')
      setSavedAt(Date.now())
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 space-y-2">
      <div>
        <h4 className="text-sm font-semibold text-un1t-text mb-1">Chat openers</h4>
        <p className="text-xs text-un1t-subtle">
          What a customer sees when they open a brand-new chat with this number (e.g. from a
          click-to-WhatsApp ad). The greeting toggle makes Meta notify us the moment they open
          the chat so the agent&apos;s welcome message sends instantly; ice breakers are tappable
          prompts they can start with.
        </p>
      </div>
      <label className="flex items-center gap-2 text-[11px] text-un1t-subtle">
        <input
          type="checkbox"
          disabled={!canEdit}
          checked={enableWelcome}
          onChange={(e) => setEnableWelcome(e.target.checked)}
        />
        Greet users when they open the chat
      </label>
      {prompts.map((p, i) => (
        <Row key={i} label={`Ice breaker ${i + 1} (optional, 80 chars)`}>
          <input
            disabled={!canEdit}
            maxLength={80}
            className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
            value={p}
            onChange={(e) => setPrompts((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
            placeholder={i === 0 ? 'e.g. What classes do you run?' : ''}
          />
        </Row>
      ))}
      {error && (
        <div className="text-xs text-red-400 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> {error}
        </div>
      )}
      {canEdit && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-un1t-text text-un1t-bg text-[11px] font-semibold hover:bg-un1t-accent disabled:opacity-50"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
            {saving ? 'Saving…' : 'Save chat openers'}
          </button>
          {savedAt && <span className="text-[11px] text-emerald-500">Saved ✓</span>}
        </div>
      )}
    </div>
  )
}

// WASTUDIOPICK.1 — the WhatsApp studio picker. A message from someone we do
// not know is filed at a studio by the ad they came from or by what they
// wrote; when that is unclear they get one question with a button per studio
// that is listed here. Settings live on locations.settings.wa_studio_picker
// via /api/whatsapp/studio-picker. Every studio can be listed (button label +
// keywords); only a studio with its own number can ask the question.
const PICKER_LABEL_MAX = 20
const PICKER_QUESTION_MAX = 1024

function StudioPickerCard({ location, canEdit }) {
  const [state, setState] = useState('loading') // loading | ready | failed
  const [hasNumber, setHasNumber] = useState(false)
  const [defaultQuestion, setDefaultQuestion] = useState('')
  const [listed, setListed] = useState(false)
  const [label, setLabel] = useState('')
  const [keywords, setKeywords] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [question, setQuestion] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/whatsapp/studio-picker?location_id=${encodeURIComponent(location.id)}`)
        const j = await res.json()
        if (cancelled) return
        if (!res.ok || !j.success || !j.data) { setState('failed'); return }
        const d = j.data
        setListed(d.listed === true)
        setLabel(d.label || '')
        setKeywords(Array.isArray(d.keywords) ? d.keywords.join(', ') : '')
        setEnabled(d.enabled === true)
        setQuestion(d.question || '')
        setHasNumber(d.has_number === true)
        setDefaultQuestion(d.default_question || '')
        setState('ready')
      } catch {
        if (!cancelled) setState('failed')
      }
    }
    load()
    return () => { cancelled = true }
  }, [location.id])

  async function save() {
    setSaving(true); setError(null); setSavedAt(null)
    try {
      const res = await fetch('/api/whatsapp/studio-picker', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: location.id,
          listed,
          label: label.trim(),
          keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
          ...(hasNumber ? { enabled, question: question.trim() } : {}),
        }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) throw new Error(j.error || 'Failed to save the studio picker')
      setSavedAt(Date.now())
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 space-y-2">
      <div>
        <h4 className="text-sm font-semibold text-un1t-text mb-1">Studio picker</h4>
        <p className="text-xs text-un1t-subtle">
          When someone we don&apos;t know messages this number, we work out which studio they mean
          from the ad they came from or their message. If it isn&apos;t clear, they get one question
          with a button for each studio shown here.
        </p>
      </div>
      {state === 'loading' && (
        <div className="text-xs text-un1t-subtle inline-flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      )}
      {state === 'failed' && (
        <div className="text-xs text-red-700 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> Could not load the studio picker settings just now. Reload the page to try again.
        </div>
      )}
      {state === 'ready' && (
        <>
          <label className="flex items-center gap-2 text-[11px] text-un1t-subtle">
            <input
              type="checkbox"
              disabled={!canEdit}
              checked={listed}
              onChange={(e) => setListed(e.target.checked)}
            />
            Show this studio in the WhatsApp studio picker
          </label>
          <p className="text-[11px] text-un1t-subtle">Studios with their own WhatsApp number are only offered on their own number.</p>
          <Row label={`Button label (${PICKER_LABEL_MAX} characters)`}>
            <input
              disabled={!canEdit}
              maxLength={PICKER_LABEL_MAX}
              className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={location.name || ''}
            />
          </Row>
          <Row label="Keywords that point to this studio (comma separated, optional)">
            <input
              disabled={!canEdit}
              className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
            />
          </Row>
          {hasNumber && (
            <>
              <label className="flex items-center gap-2 text-[11px] text-un1t-subtle">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                Ask new senders which studio they mean
              </label>
              <Row label="Question">
                <textarea
                  disabled={!canEdit}
                  maxLength={PICKER_QUESTION_MAX}
                  rows={3}
                  className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={defaultQuestion}
                />
              </Row>
            </>
          )}
          {error && (
            <div className="text-xs text-red-700 inline-flex items-center gap-1.5">
              <AlertCircle size={12} /> {error}
            </div>
          )}
          {canEdit && (
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-un1t-text text-un1t-bg text-[11px] font-semibold hover:bg-un1t-accent disabled:opacity-50"
              >
                {saving ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                {saving ? 'Saving…' : 'Save studio picker'}
              </button>
              {savedAt && <span className="text-[11px] text-emerald-700">Saved ✓</span>}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// C4 — operator-curated card sets for the in-session WhatsApp media
// carousel (2-10 swipeable image cards; each card = image + title +
// optional body + optional link button). Staff send a set from the inbox
// composer while the 24h window is open — no template approval needed.
// Stored on locations.settings.wa_card_sets via /api/whatsapp/card-sets
// (PUT replaces the whole array). Meta requires consistent button config
// across cards, so each set is all-links-or-none — validated here before
// save and again server-side.
const emptyCard = () => ({ image_url: '', title: '', body: '', link_url: '', link_text: '' })

function validateCardSetDraft(draft) {
  if (!draft.name.trim()) return 'Give the card set a name'
  if (draft.cards.length < 2 || draft.cards.length > 10) return 'A card set needs 2-10 cards'
  for (let i = 0; i < draft.cards.length; i++) {
    const c = draft.cards[i]
    if (!c.image_url.trim()) return `Card ${i + 1} needs an image`
    if (!c.title.trim()) return `Card ${i + 1} needs a title`
    if (c.link_text.trim() && !c.link_url.trim()) return `Card ${i + 1} has button text but no link URL`
  }
  const withLinks = draft.cards.filter((c) => c.link_url.trim()).length
  if (withLinks !== 0 && withLinks !== draft.cards.length) {
    return 'WhatsApp requires consistent buttons: give every card a link, or none'
  }
  return null
}

// Trim + drop empty optional fields so the payload matches the API schema.
// URLs get https:// prefixed when the operator typed a bare domain — the
// server normalises identically, but doing it here keeps what's stored equal
// to what was validated.
function normalizeCardSet(draft) {
  return {
    id: draft.id,
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    ...(draft.body_text.trim() ? { body_text: draft.body_text.trim() } : {}),
    cards: draft.cards.map((c) => ({
      image_url: normalizeUrlish(c.image_url),
      title: c.title.trim(),
      ...(c.body.trim() ? { body: c.body.trim() } : {}),
      ...(c.link_url.trim() ? { link_url: normalizeUrlish(c.link_url) } : {}),
      ...(c.link_url.trim() && c.link_text.trim() ? { link_text: c.link_text.trim() } : {}),
    })),
  }
}

function CardSetsCard({ location, canEdit }) {
  const [sets, setSets] = useState(() => (
    Array.isArray(location.settings?.wa_card_sets) ? location.settings.wa_card_sets : []
  ))
  const [editing, setEditing] = useState(null) // draft copy of the set being created/edited
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState(null)

  function startNew() {
    setEditing({ id: crypto.randomUUID(), name: '', description: '', body_text: '', cards: [emptyCard(), emptyCard()] })
    setError(null); setSavedAt(null)
  }

  function startEdit(s) {
    setEditing({
      id: s.id,
      name: s.name || '',
      description: s.description || '',
      body_text: s.body_text || '',
      cards: (s.cards || []).map((c) => ({
        image_url: c.image_url || '', title: c.title || '', body: c.body || '',
        link_url: c.link_url || '', link_text: c.link_text || '',
      })),
    })
    setError(null); setSavedAt(null)
  }

  async function persist(nextSets) {
    setSaving(true); setError(null); setSavedAt(null)
    try {
      const res = await fetch('/api/whatsapp/card-sets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: location.id, sets: nextSets }),
      })
      const j = await res.json()
      if (!j.success) {
        // Surface the first zod issue instead of the generic message — a bare
        // "Invalid request body" cost real debugging time on first use.
        const issue = Array.isArray(j.issues) && j.issues[0]
        const detail = issue ? ` — ${[issue.path?.join?.('.'), issue.message].filter(Boolean).join(': ')}` : ''
        throw new Error((j.error || 'Failed to save card sets') + detail)
      }
      setSets(j.sets || nextSets)
      setEditing(null)
      setSavedAt(Date.now())
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  function saveDraft() {
    const problem = validateCardSetDraft(editing)
    if (problem) { setError(problem); return }
    const normalized = normalizeCardSet(editing)
    const next = sets.some((s) => s.id === normalized.id)
      ? sets.map((s) => (s.id === normalized.id ? normalized : s))
      : [...sets, normalized]
    persist(next)
  }

  function removeSet(s) {
    if (!confirm(`Delete card set "${s.name}"? The inbox "Send cards" picker will no longer offer it.`)) return
    persist(sets.filter((x) => x.id !== s.id))
  }

  function updateDraftCard(i, patch) {
    setEditing((prev) => ({ ...prev, cards: prev.cards.map((c, j) => (j === i ? { ...c, ...patch } : c)) }))
  }

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 space-y-2">
      <div>
        <h4 className="text-sm font-semibold text-un1t-text mb-1">Card sets</h4>
        <p className="text-xs text-un1t-subtle">
          Curated sets of 2-10 swipeable image cards staff can send from the inbox while a
          conversation&apos;s 24h window is open — no template approval needed. Each card has an
          image, a title, and optionally a short body and a link button. WhatsApp requires
          buttons to be consistent: give every card in a set a link, or none.
        </p>
      </div>

      {sets.length === 0 && !editing && (
        <p className="text-[11px] text-un1t-muted">No card sets yet.</p>
      )}

      {sets.map((s) => (
        <div key={s.id} className="flex items-center justify-between gap-2 bg-un1t-surface/30 border border-un1t-border rounded px-2 py-1.5">
          <div className="min-w-0">
            <span className="text-xs font-medium text-un1t-text truncate">{s.name}</span>
            <span className="text-[11px] text-un1t-muted ml-2">{s.cards?.length || 0} cards</span>
            {(s.cards || []).some((c) => c.link_url) && (
              <span className="text-[10px] uppercase text-un1t-muted ml-2">Linked</span>
            )}
          </div>
          {canEdit && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => startEdit(s)}
                disabled={saving}
                className="text-un1t-subtle hover:text-un1t-text p-1 disabled:opacity-50"
                title="Edit this card set"
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                onClick={() => removeSet(s)}
                disabled={saving}
                className="text-un1t-subtle hover:text-red-500 p-1 disabled:opacity-50"
                title="Delete this card set"
              >
                <Trash2 size={12} />
              </button>
            </div>
          )}
        </div>
      ))}

      {error && (
        <div className="text-xs text-red-400 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> {error}
        </div>
      )}
      {savedAt && !editing && <div className="text-[11px] text-emerald-500">Saved ✓</div>}

      {canEdit && !editing && (
        <button
          type="button"
          onClick={startNew}
          disabled={saving || sets.length >= 20}
          className="inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent disabled:opacity-50"
        >
          <Plus size={11} /> Add card set
        </button>
      )}

      {editing && (
        <div className="border border-un1t-border rounded-md p-2.5 space-y-2 bg-un1t-surface/30">
          <Row label="Set name (shown to staff, 60 chars)">
            <input
              maxLength={60}
              className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
              value={editing.name}
              onChange={(e) => setEditing((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="e.g. Membership options"
            />
          </Row>
          <Row label="When should Mia send this? (shown to the AI, 200 chars)">
            <input
              maxLength={200}
              className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
              value={editing.description}
              onChange={(e) => setEditing((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="When someone asks about membership options or pricing"
            />
          </Row>
          <Row label="Message text (optional — sent above the cards; defaults to the set name)">
            <textarea
              rows={2}
              maxLength={1024}
              className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
              value={editing.body_text}
              onChange={(e) => setEditing((prev) => ({ ...prev, body_text: e.target.value }))}
            />
          </Row>

          {editing.cards.map((c, i) => (
            <div key={i} className="border border-un1t-border rounded p-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-un1t-subtle">Card {i + 1}</span>
                {editing.cards.length > 2 && (
                  <button
                    type="button"
                    onClick={() => setEditing((prev) => ({ ...prev, cards: prev.cards.filter((_, j) => j !== i) }))}
                    className="text-un1t-subtle hover:text-red-500 p-0.5"
                    title="Remove this card"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
              <CardImageField
                locationId={location.id}
                value={c.image_url}
                onChange={(url) => updateDraftCard(i, { image_url: url })}
                onError={setError}
              />
              <div className="grid grid-cols-2 gap-1.5">
                <Row label="Title (80 chars)">
                  <input
                    maxLength={80}
                    className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
                    value={c.title}
                    onChange={(e) => updateDraftCard(i, { title: e.target.value })}
                  />
                </Row>
                <Row label="Body (optional, 160 chars)">
                  <input
                    maxLength={160}
                    className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
                    value={c.body}
                    onChange={(e) => updateDraftCard(i, { body: e.target.value })}
                  />
                </Row>
                <Row label="Link URL (all cards or none)">
                  <input
                    className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono"
                    value={c.link_url}
                    onChange={(e) => updateDraftCard(i, { link_url: e.target.value })}
                    placeholder="https://…"
                  />
                </Row>
                <Row label="Button text (20 chars, default 'Open')">
                  <input
                    maxLength={20}
                    className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
                    value={c.link_text}
                    onChange={(e) => updateDraftCard(i, { link_text: e.target.value })}
                  />
                </Row>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={() => setEditing((prev) => ({ ...prev, cards: [...prev.cards, emptyCard()] }))}
            disabled={editing.cards.length >= 10}
            className="inline-flex items-center gap-1 text-[11px] text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
          >
            <Plus size={11} /> Add card ({editing.cards.length}/10)
          </button>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={saveDraft}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-un1t-text text-un1t-bg text-[11px] font-semibold hover:bg-un1t-accent disabled:opacity-50"
            >
              {saving ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
              {saving ? 'Saving…' : 'Save card set'}
            </button>
            <button
              type="button"
              onClick={() => { setEditing(null); setError(null) }}
              className="text-[11px] text-un1t-subtle hover:text-un1t-text"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Card image — reuses the template-media 3-step signed-upload flow
// (sign → browser-direct storage upload → finalise; see WATemplateEditor's
// handleMediaUpload for the original): we only keep the returned public
// `url`, which is exactly what the carousel send feeds Meta. A plain URL
// input sits alongside for operators pasting an already-hosted image.
function CardImageField({ locationId, value, onChange, onError }) {
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef(null)

  async function handleUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    onError(null)
    try {
      // Instant pre-check against Meta's caps (IMAGE: jpeg/png, 5 MB).
      const pre = validateTemplateMedia({ format: 'IMAGE', mime: file.type, size: file.size, fileName: file.name })
      if (!pre.ok) { onError(pre.error); return }

      // 1. Mint a signed direct-to-storage upload slot.
      const signRes = await fetch('/api/whatsapp/templates/upload-media/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'IMAGE', mime: file.type, size: file.size, file_name: file.name, location_id: locationId }),
      })
      const sign = await signRes.json().catch(() => ({}))
      if (!sign.success) { onError(sign.error || 'Could not start the upload'); return }

      // 2. Browser → Supabase Storage directly (bypasses Vercel).
      const supabase = createBrowserClient()
      const { error: upErr } = await supabase.storage
        .from('whatsapp-templates')
        .uploadToSignedUrl(sign.path, sign.token, file, { contentType: file.type })
      if (upErr) { onError(`Storage upload failed: ${upErr.message}`); return }

      // 3. Finalise → public URL. (Also mints a Meta template handle we
      //    don't need here — carousels send images by link.)
      const res = await fetch('/api/whatsapp/templates/upload-media', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: sign.path, format: 'IMAGE', mime: file.type, file_name: file.name, location_id: locationId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!j.success || !j.url) { onError(j.error || 'Upload failed'); return }
      onChange(j.url)
    } catch (err) {
      onError(err.message || 'Network error')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <Row label="Image (JPEG/PNG — upload or paste a public URL)">
      <div className="flex items-center gap-1.5">
        {value && (
          <img src={value} alt="" className="w-8 h-8 rounded object-cover border border-un1t-border shrink-0" />
        )}
        <input
          className="flex-1 bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text font-mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://…"
        />
        <input ref={fileRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={handleUpload} />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-50 shrink-0"
        >
          {uploading ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </Row>
  )
}
