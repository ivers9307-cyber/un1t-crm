'use client'

// PAGES.1 — one studio's half of a page's offer (a landing_page_studios row):
// whether the page is switched on there, the type's studio fields
// (studio-offer-fields.jsx), the tag and lead source, a readiness chip and its
// own Save: PUT /api/landing-pages/<page.id>/studios/<location_id> with
// { enabled, offer, attribution }. Independent of the page form's Save.
//
// The chip starts as the server's readiness when the page carries it
// (row.readiness), else a local hint (offerConfigured on the merged block,
// which cannot know the studio's path or its un1t.online product); after an
// edit it is the local hint, and after each save the API's readiness until
// the next edit: the server's answer wins. onSave(location_id, { row, readiness }) lets the page keep `studios`
// current. canEdit false: every control disabled, no Save, no catalogue fetch.

import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  OFFER_BLOCK_TYPE, mergeOfferBlock, offerConfigured, defaultAttribution,
} from '@/lib/landing-page-offers'
import { pageSaveMessage } from '@/components/landing-pages/page-save'
import { Field, Input } from '@/components/landing-pages/fields'
import { StudioOfferFields, fieldsFromOffer, offerFromFields } from '@/components/landing-pages/studio-offer-fields'

const CHIPS = {
  ready: ['Ready', 'bg-green-500/10 text-green-700'],
  needs_plan: ['Needs a plan', 'bg-amber-500/10 text-amber-700'],
  no_platform: ['No platform', 'bg-gray-500/10 text-gray-700'],
}

function attributionDraft(attribution) {
  return {
    tag: typeof attribution?.tag === 'string' ? attribution.tag : '',
    lead_source: typeof attribution?.lead_source === 'string' ? attribution.lead_source : '',
  }
}

/**
 * The attribution a save sends: the non-blank tag and lead source (blank =
 * use the default). A stored Meta page URL, which this row does not edit,
 * goes back unchanged so a save never drops it.
 */
function attributionToSend(draft, stored) {
  const out = {}
  for (const key of ['tag', 'lead_source']) {
    const v = (draft[key] || '').trim()
    if (v) out[key] = v
  }
  if (typeof stored?.event_source_url === 'string' && stored.event_source_url) out.event_source_url = stored.event_source_url
  return out
}

function swallowEnter(e) {
  if (e.key === 'Enter' && e.target?.tagName === 'INPUT') e.preventDefault()
}

export default function StudioOfferRow({ page, row, onSave, canEdit }) {
  const blockType = OFFER_BLOCK_TYPE[page?.offer_type] || null
  const pageBlock = (Array.isArray(page?.blocks) ? page.blocks : []).find((b) => b?.type === blockType) || { type: blockType }
  const name = row.name || 'This studio'

  const [enabled, setEnabled] = useState(Boolean(row.enabled))
  const [fields, setFields] = useState(() => fieldsFromOffer(blockType, row.offer))
  const [attr, setAttr] = useState(() => attributionDraft(row.attribution))
  const [stored, setStored] = useState(row.attribution || {})
  // Seeded from the server's answer when the page carries one (row.readiness),
  // so a un1t.online row the local hint cannot judge starts right.
  const [serverReadiness, setServerReadiness] = useState(() => (row.readiness?.reason ? row.readiness : null))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  const edited = () => { setServerReadiness(null); setSavedAt(null) }
  const setField = (patch) => { setFields((prev) => ({ ...prev, ...patch })); edited() }
  const setAttrField = (patch) => { setAttr((prev) => ({ ...prev, ...patch })); edited() }

  const offer = useMemo(() => offerFromFields(blockType, fields), [blockType, fields])
  const attribution = attributionToSend(attr, stored)
  const localReady = blockType
    ? offerConfigured(blockType, mergeOfferBlock(pageBlock, { offer, attribution }), { landingPath: null, product: null })
    : false
  const reason = serverReadiness?.reason || (localReady ? 'ready' : 'needs_plan')
  const [chipLabel, chipCls] = CHIPS[reason] || CHIPS.needs_plan

  // The server's default is named for the studio's public path: shown only
  // when the row knows it (studioRowView's public_path).
  const defaults = row.public_path ? defaultAttribution({ publicPath: row.public_path, slug: page?.slug || '' }) : null
  const blankHint = defaults ? 'Blank uses the default shown.' : 'Blank uses the default for this studio.'

  async function save() {
    if (!canEdit) return
    setError(null)
    setSaving(true)
    try {
      const r = await fetch(`/api/landing-pages/${page.id}/studios/${row.location_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, offer, attribution }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) { setError(pageSaveMessage(j, r.status)); return }
      const saved = j.data?.row || { ...row, enabled, offer, attribution }
      setEnabled(Boolean(saved.enabled))
      setFields(fieldsFromOffer(blockType, saved.offer))
      setAttr(attributionDraft(saved.attribution))
      setStored(saved.attribution || {})
      setServerReadiness(j.data?.readiness || null)
      setSavedAt(new Date())
      onSave?.(row.location_id, { row: saved, readiness: j.data?.readiness || null })
    } catch {
      setError('Save failed. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="border border-un1t-border rounded-lg bg-un1t-bg p-3 space-y-3">
      {/* Enter in a row's text input would submit the page form around it. */}
      <fieldset disabled={!canEdit} onKeyDown={swallowEnter} className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-un1t-text">{name}</h4>
          <span className={`text-[11px] font-medium rounded-full px-2 py-0.5 ${chipCls}`}>{chipLabel}</span>
        </div>
        <label className="flex items-center gap-2 text-sm text-un1t-text cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => { setEnabled(e.target.checked); edited() }}
            aria-label={`Switched on at ${name}`}
            className="w-4 h-4"
          />
          Switched on at this studio
        </label>
        <StudioOfferFields blockType={blockType} row={row} load={Boolean(canEdit)} fields={fields} set={setField} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Tag" hint={`On every lead from this studio. ${blankHint}`}>
            <Input ariaLabel="Tag" value={attr.tag} onChange={(v) => setAttrField({ tag: v })} maxLength={80} placeholder={defaults?.tag} />
          </Field>
          <Field label="Lead source" hint={`What the reports and the server Lead carry. ${blankHint}`}>
            <Input ariaLabel="Lead source" value={attr.lead_source} onChange={(v) => setAttrField({ lead_source: v })} maxLength={80} placeholder={defaults?.lead_source} />
          </Field>
        </div>
      </fieldset>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      {canEdit && (
        <div className="flex items-center justify-end gap-2">
          {savedAt && !saving && <span className="text-xs text-emerald-700">Saved {savedAt.toLocaleTimeString('en-IE')}</span>}
          <button
            type="button"
            onClick={save}
            disabled={saving}
            aria-label={`Save ${name}`}
            className="inline-flex items-center gap-1.5 bg-un1t-text text-un1t-bg font-semibold text-xs py-1.5 px-3 rounded-md hover:bg-un1t-accent disabled:opacity-50"
          >
            {saving && <Loader2 size={12} className="animate-spin" />}
            {saving ? 'Saving…' : 'Save studio'}
          </button>
        </div>
      )}
    </section>
  )
}
