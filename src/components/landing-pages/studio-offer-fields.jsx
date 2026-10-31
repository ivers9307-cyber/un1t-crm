'use client'

// PAGES.1 — the studio half of each offer type, as StudioOfferRow edits it:
// one small field group per block type over a flat `fields` map (every value
// a string while it is edited; offerFromFields turns it into the row's
// `offer`). The Glofox plan list and the un1t.online products are loaded per
// studio from the same endpoints the legacy block editors use.

import { useEffect, useState } from 'react'
import { STUDIO_OFFER_KEYS } from '@/lib/landing-page-offers'
import { buildTrialOptions } from '@/lib/glofox-trial-options'
import { centsToEuros, eurosToCents } from '@/lib/price-format'
import { liveCorpPromos } from '@/lib/corp-promos'
import { DEFAULT_MIN_NOTICE_HOURS } from '@/lib/manual-timetable'
import { Field, Input, Textarea } from '@/components/landing-pages/fields'
import { TimetableReadBack } from '@/components/landing-pages/timetable-read-back'

const NUMBER_KEYS = new Set(['price_cents', 'duration_days', 'min_notice_hours'])
const RAW_TEXT_KEYS = new Set(['timetable', 'class_keywords'])
const selectCls = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text'

/** A row's stored offer as editable strings (price shown in euros). */
export function fieldsFromOffer(blockType, offer) {
  const out = {}
  for (const key of STUDIO_OFFER_KEYS[blockType] || []) {
    const v = offer?.[key]
    if (v === undefined || v === null) continue
    out[key] = key === 'price_cents' ? centsToEuros(v) || String(v) : String(v)
  }
  return out
}

/**
 * The `offer` a save sends: the type's studio keys that hold a value (a blank
 * is no value), numbers as numbers. A number field that does not read as one
 * goes as typed, so the API's validation names it.
 */
export function offerFromFields(blockType, fields) {
  const out = {}
  for (const key of STUDIO_OFFER_KEYS[blockType] || []) {
    const raw = fields?.[key]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    if (NUMBER_KEYS.has(key)) {
      const n = Number(raw.trim())
      out[key] = !Number.isFinite(n) ? raw : key === 'price_cents' ? eurosToCents(raw) : n
    } else {
      out[key] = RAW_TEXT_KEYS.has(key) ? raw : raw.trim()
    }
  }
  return out
}

function useCatalogue(url, pick) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!url) return
    let alive = true
    setLoading(true)
    fetch(url, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j && j.success !== false) setItems(pick(j)) })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [url]) // eslint-disable-line react-hooks/exhaustive-deps
  return { items, loading }
}

const pickMemberships = (j) => j.memberships || j.data || []
const pickProducts = (j) => (Array.isArray(j.data?.paid_products) ? j.data.paid_products : [])

// The Glofox plan picker: one `${membershipId}:${planCode}` value written to
// two keys. The saved pair stays selectable before the list loads.
function TrialPlanPicker({ row, load, fields, set, idKey, codeKey, hint, emptyLabel }) {
  const url = load && row.membership_source !== 'un1t_online' ? `/api/locations/${row.location_id}/glofox-memberships` : null
  const { items, loading } = useCatalogue(url, pickMemberships)
  const value = fields[idKey] && fields[codeKey] ? `${fields[idKey]}:${fields[codeKey]}` : ''
  const options = buildTrialOptions(items, value)
  const onChange = (v) => {
    const [mid, pc] = v ? v.split(':') : ['', '']
    set({ [idKey]: mid || '', [codeKey]: pc || '' })
  }
  if (row.membership_source === 'un1t_online') {
    return <p className="text-[11px] text-un1t-muted">This studio books through un1t.online; Glofox plans do not apply.</p>
  }
  return (
    <Field label="Glofox trial plan" hint={loading ? 'Loading Glofox products…' : hint}>
      <select aria-label="Glofox trial plan" value={value} onChange={(e) => onChange(e.target.value)} className={selectCls}>
        <option value="">{emptyLabel}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  )
}

function Text({ label, k, fields, set, hint, maxLength = 200, placeholder }) {
  return (
    <Field label={label} hint={hint}>
      <Input ariaLabel={label} value={fields[k] || ''} onChange={(v) => set({ [k]: v })} maxLength={maxLength} placeholder={placeholder} />
    </Field>
  )
}

function PaidTrialFields({ row, load, fields, set }) {
  const un1t = row.membership_source === 'un1t_online'
  const url = load && un1t ? `/api/locations/${row.location_id}/un1t-online` : null
  const { items: products, loading } = useCatalogue(url, pickProducts)
  const productId = fields.un1t_product_id || ''
  return (
    <>
      {un1t ? (
        <Field label="un1t.online product" hint={loading ? 'Loading un1t.online products…' : "The price buyers see is the product's live price."}>
          <select aria-label="un1t.online product" value={productId} onChange={(e) => set({ un1t_product_id: e.target.value })} className={selectCls}>
            <option value="">Not set (sells nothing here)</option>
            {productId && !products.some((p) => p.un1t_id === productId) && <option value={productId}>{productId}</option>}
            {products.map((p) => <option key={p.un1t_id} value={p.un1t_id}>{`${p.title} · €${centsToEuros(p.price_cents)}`}</option>)}
          </select>
        </Field>
      ) : (
        <>
          <TrialPlanPicker row={row} load={load} fields={fields} set={set} idKey="membership_id" codeKey="plan_code" emptyLabel="Not set (sells nothing here)"
            hint="REQUIRED. A €0 plan in Glofox for this trial (the money is taken here, not by Glofox)." />
          <Text label="Price (€)" k="price_cents" fields={fields} set={set} maxLength={10} placeholder="39" hint="What the buyer pays, taken by the studio's payment rail." />
          <Text label="Trial length (days)" k="duration_days" fields={fields} set={set} maxLength={3} placeholder="14" />
        </>
      )}
      <Text label="Product name" k="product_name" fields={fields} set={set} maxLength={80} hint="On the checkout line, the receipt and the confirmation email." />
      <Text label="Studio label on the picker" k="studio_label" fields={fields} set={set} maxLength={60} hint="The name on this studio's choice card. Blank shows the studio's own name." />
    </>
  )
}

// The typed-in timetable, with the legacy editor's hints and its read-back.
function TimetableFields({ fields, set }) {
  const text = fields.timetable || ''
  return (
    <div className="space-y-3 pt-3 border-t border-un1t-border">
      <p className="text-[11px] text-un1t-muted">
        Typed-in timetable: only used when this studio has no Glofox connection. Visitors pick one of these times and leave their details; each request appears in Approvals for staff to book by hand. A studio on un1t.online ignores the timetable and the first bookable date, but the minimum notice still applies.
      </p>
      <Field label="Weekly timetable" hint="One line per class: day, time, class name. Several days or times can share a line, e.g. “Mon-Fri 06:15, 07:15 Strength” or “Sat 9am Conditioning”.">
        <Textarea ariaLabel="Weekly timetable" value={text} onChange={(v) => set({ timetable: v })} maxLength={4000} rows={5} placeholder={'Mon-Fri 06:15 Strength\nSat 09:00 Strength'} />
        <TimetableReadBack text={text} />
      </Field>
      <Field label="First bookable date" hint="Optional. No class before this date is offered, e.g. the studio's opening day.">
        <input type="date" aria-label="First bookable date" value={fields.timetable_start_date || ''} onChange={(e) => set({ timetable_start_date: e.target.value })} className={selectCls} />
      </Field>
      <Text label="Minimum notice (hours)" k="min_notice_hours" fields={fields} set={set} maxLength={3} placeholder={String(DEFAULT_MIN_NOTICE_HOURS)}
        hint={`A class starting sooner than this is not offered, so staff have time to book it by hand. Blank = ${DEFAULT_MIN_NOTICE_HOURS} hours.`} />
    </div>
  )
}

function ClassFunnelFields({ row, load, fields, set }) {
  return (
    <>
      <TrialPlanPicker row={row} load={load} fields={fields} set={set} idKey="trial_membership_id" codeKey="trial_plan_code" emptyLabel="Use the studio default"
        hint="Which Glofox membership and plan a new member gets on booking. Leave on the studio default unless this page grants a different intro offer." />
      <Text label="Price (€)" k="price_cents" fields={fields} set={set} maxLength={10} placeholder="e.g. 29" hint="Blank for a free trial. If set, the funnel charges this; the studio's payment rail must be set up." />
      <Text label="Free-consult upsell" k="consult_slug" fields={fields} set={set} placeholder="free-un1t-consultation" hint="Optional. The booking type offered after a class is booked, by its slug. Blank for no upsell." />
      <TimetableFields fields={fields} set={set} />
    </>
  )
}

function CampaignFunnelFields({ row, load, fields, set }) {
  return (
    <>
      <TrialPlanPicker row={row} load={load} fields={fields} set={set} idKey="trial_membership_id" codeKey="trial_plan_code" emptyLabel="Not set (takes no bookings here)"
        hint="REQUIRED. The plan put on a new person's account before their booking. It never falls back to the studio's default trial." />
      <Field label="Classes offered (keywords)" hint="One per line. A class is offered only when its name contains any of them (case does not matter). Empty offers nothing.">
        <Textarea ariaLabel="Classes offered (keywords)" value={fields.class_keywords || ''} onChange={(v) => set({ class_keywords: v })} maxLength={200} rows={2} placeholder="50+" />
      </Field>
    </>
  )
}

function CorpPromoFields({ fields, set }) {
  const promos = liveCorpPromos()
  const key = fields.promo_key || ''
  return (
    <Field label="Promo" hint="The credits and their expiry are fixed per promo.">
      <select aria-label="Promo" value={key} onChange={(e) => set({ promo_key: e.target.value })} className={selectCls}>
        <option value="">Not set</option>
        {key && !promos.some((p) => p.key === key) && <option value={key}>{key}</option>}
        {promos.map((p) => <option key={p.key} value={p.key}>{`${p.name || p.key} · ${p.credits} credits`}</option>)}
      </select>
    </Field>
  )
}

const FIELD_GROUPS = {
  paid_trial: PaidTrialFields,
  class_funnel: ClassFunnelFields,
  campaign_funnel: CampaignFunnelFields,
  corp_promo: CorpPromoFields,
}

/** The block type's studio field group; `load` false fetches no catalogue. */
export function StudioOfferFields({ blockType, row, load, fields, set }) {
  const Group = FIELD_GROUPS[blockType]
  return Group ? <Group row={row} load={load} fields={fields} set={set} /> : null
}
