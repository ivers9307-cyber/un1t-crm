'use client'

// ClassPickStep — CLASSFIRST.1: the "pick your class" step shared by the
// one_class cards: /50plus (CampaignFunnel, where it was born as
// FIFTYPLUS.1's date tiles), /trial (PaidTrialFunnel) and /corp
// (CorpPromoFunnel). It owns the list fetch (GET /api/public/classes for the
// page and its studio, or the legacy path + campaign), the day-ordered tiles
// (three in view on a phone, the rest behind "More dates"), the four empty
// states in the operator's words, and the continue button. The PARENT owns
// the choice (`chosen` / `onPick`), what happens next (`onContinue`), its
// telemetry (`onLoaded` tells it what the list said) and the card round it.
//
// Two shapes (CLASSFIRST.2): a timetable with at most one slot a day
// (/50plus: one class, three mornings a week) is the flat date tiles; a
// timetable with more than one slot on any day (a full studio: eight
// classes a day) is DAY-FIRST, a row of day tiles and then that day's slots
// as a short list, so the card stays the height of one day and never
// stretches the hero beside it.
//
// The list itself is `useClassList`'s, held by the PARENT so it survives a
// step change (Change on the details step returns to the tiles with no
// second fetch) and is passed in as `list`.
//
// MOBILEFUNNEL.1 — day-first: below `lg` the day tiles are one row that
// scrolls sideways (the selected day is kept in view), and tapping a time
// picks it AND continues (`onContinue(cls)`: the class travels with the call,
// because the parent's `chosen` is still the old value until it re-renders),
// so that shape has no continue button. The flat tiles keep theirs, which
// calls `onContinue(chosen)`.
//
// `onSkip` (optional): with the list empty or unreadable, a typed button
// (`copy.skip_class_label`) lets the visitor go on without a class: a paid
// trial still sells on a timetable blip. `showClassName` puts the class name
// on each tile (one studio lists many classes; /50plus lists one and omits
// it). The editor's preview lists the real classes too (a public GET) so the
// operator sees the step as a visitor does; the parent disables the POST.
import { useEffect, useRef, useState } from 'react'

const VISIBLE_TILES = 3
// en-IE day labels read "Mon, 2 Nov": the weekday is the first token before
// the comma or space.
export const labelParts = (label) => String(label || '').split(/[,\s]+/).filter(Boolean)
export const PICK_CTA_CLS = 'w-full rounded-full bg-black text-white py-4 px-6 font-bold text-base disabled:opacity-50'

/** The slots grouped by day, in day order. Pure. */
export function cadenceGroups(classes) {
  const byDay = new Map()
  for (const c of Array.isArray(classes) ? classes : []) {
    if (!c || !c.day) continue
    if (!byDay.has(c.day)) byDay.set(c.day, { day: c.day, day_label: c.day_label || c.day, classes: [] })
    byDay.get(c.day).classes.push(c)
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
}

/** The CTA label: `{day}` is the weekday off day_label, `{time}` the slot's time. */
export function ctaLabelFor(template, cls) {
  const t = typeof template === 'string' && template.trim() ? template : 'Book {day} {time}'
  const weekday = labelParts(cls?.day_label)[0] || ''
  return t.replace('{day}', weekday).replace('{time}', cls?.time || '').replace(/\s+/g, ' ').trim()
}

// Where a request is about: the page and its studio, or (no page) the legacy path and campaign.
export function campaignFunnelTarget({ page, publicPath, campaign }) {
  return page ? { page, studio: publicPath || undefined } : { path: publicPath, campaign }
}

export function campaignFunnelClassesUrl({ page, publicPath, campaign }) {
  if (page) {
    const q = new URLSearchParams({ page })
    if (publicPath) q.set('studio', publicPath)
    return `/api/public/classes?${q.toString()}`
  }
  const q = new URLSearchParams({ path: publicPath || '' })
  if (campaign) q.set('campaign', campaign)
  return `/api/public/classes?${q.toString()}`
}

export function Tile({ cls, selected, onPick, beyondFirstRow, showName = false, disabled = false }) {
  const [weekday, dateNumber = '', ...rest] = labelParts(cls.day_label)
  const month = rest.join(' ')
  // The second week is a tap away on a phone and in view on a wide screen.
  const reveal = beyondFirstRow ? 'hidden lg:block' : ''
  return (
    <button
      type="button"
      data-tile={cls.event_id}
      disabled={disabled}
      onClick={() => onPick(cls)}
      aria-pressed={selected}
      className={`${reveal} rounded-2xl px-2 py-3 text-center transition ${selected ? 'bg-black text-white' : 'bg-white border border-black/15 text-black hover:border-black/40'} disabled:opacity-60`}
    >
      <span className={`block text-xs ${selected ? 'text-white/70' : 'text-black/60'}`}>{weekday}</span>
      <span className="block font-display font-extrabold text-2xl leading-tight">{dateNumber}</span>
      {showName && <span className={`block text-[11px] font-semibold uppercase tracking-wide truncate ${selected ? 'text-white/90' : 'text-black/80'}`}>{cls.name}</span>}
      <span className={`block text-xs ${selected ? 'text-white/80' : 'text-black/70'}`}>{showName ? '' : month ? `${month} · ` : ''}{cls.time}</span>
      <span className="sr-only">{cls.day_label}{showName ? ` ${cls.name}` : ''}</span>
    </button>
  )
}

/** Day-first when any day holds more than one slot. Pure. */
export function isDayFirst(groups) {
  return Array.isArray(groups) && groups.some((g) => (g.classes || []).length > 1)
}

// MOBILEFUNNEL.1 — below `lg` the days are one sideways row: each tile at
// least 52px wide and 44px tall, snapping; from `lg` the 7-column grid.
export const DAY_ROW_CLS = 'relative flex gap-1.5 overflow-x-auto snap-x snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:grid lg:grid-cols-7 lg:overflow-visible lg:snap-none'
const DAY_TILE_SIZE_CLS = 'shrink-0 snap-start w-[3.25rem] min-h-[44px] lg:w-auto lg:min-h-0'

function DayTile({ group, selected, onPick }) {
  const [weekday, dateNumber = ''] = labelParts(group.day_label)
  return (
    <button
      type="button"
      data-day={group.day}
      onClick={() => onPick(group.day)}
      aria-pressed={selected}
      className={`${DAY_TILE_SIZE_CLS} rounded-xl px-1 py-2 text-center transition ${selected ? 'bg-black text-white' : 'bg-white border border-black/15 text-black hover:border-black/40'}`}
    >
      <span className={`block text-[11px] ${selected ? 'text-white/70' : 'text-black/60'}`}>{weekday}</span>
      <span className="block font-display font-extrabold text-xl leading-tight">{dateNumber}</span>
      <span className="sr-only">{group.day_label}</span>
    </button>
  )
}

function SlotRow({ cls, selected, onPick }) {
  return (
    <button
      type="button"
      data-tile={cls.event_id}
      onClick={() => onPick(cls)}
      aria-pressed={selected}
      className={`w-full flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-left transition ${selected ? 'bg-black text-white' : 'bg-white border border-black/15 text-black hover:border-black/40'}`}
    >
      <span className="font-display font-extrabold text-lg leading-none tabular-nums">{cls.time}</span>
      <span className={`text-sm font-semibold uppercase tracking-wide truncate ${selected ? 'text-white/90' : 'text-black/80'}`}>{cls.name}</span>
      <span className="sr-only">{cls.day_label}</span>
    </button>
  )
}

/**
 * Scroll a sideways row so its selected tile is in view. Only the row moves
 * (its scrollLeft), never the page: scrollIntoView would also scroll the
 * window to the card. The row is `relative`, so a tile's offsetLeft is
 * measured from it. Pure DOM, no-op when the row does not overflow.
 */
export function keepSelectedInView(row) {
  if (!row) return
  const tile = row.querySelector('[aria-pressed="true"]')
  if (!tile || row.scrollWidth <= row.clientWidth) return
  const pad = 8
  const left = tile.offsetLeft
  const right = left + tile.offsetWidth
  if (left - pad < row.scrollLeft) row.scrollLeft = Math.max(0, left - pad)
  else if (right + pad > row.scrollLeft + row.clientWidth) row.scrollLeft = right + pad - row.clientWidth
}

/**
 * The studio's bookable classes for a card. Fetches on mount and whenever
 * `reloadKey` changes (a reload never preselects: that is the caller's,
 * through `onLoaded`); with `enabled` false (no studio chosen yet) nothing is
 * fetched and the list stays loading.
 * @returns {{ classes: object[], loading: boolean, configured: boolean, unavailable: boolean }}
 */
export function useClassList({ page = null, publicPath = null, campaign = null, reloadKey = 0, enabled = true, onLoaded = null }) {
  const [classes, setClasses] = useState([])
  const [loading, setLoading] = useState(true)
  const [configured, setConfigured] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const onLoadedRef = useRef(onLoaded)
  useEffect(() => { onLoadedRef.current = onLoaded })

  useEffect(() => {
    if (!enabled) return undefined
    let alive = true
    setLoading(true)
    // Through a resolved promise so a missing fetch (an old browser, a bare
    // test) rejects into "unavailable" instead of throwing in the effect.
    Promise.resolve()
      .then(() => fetch(campaignFunnelClassesUrl({ page, publicPath, campaign })))
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        const list = (j?.success && Array.isArray(j.data?.classes)) ? j.data.classes : []
        const ok = j?.data?.campaign?.configured !== false
        const blip = j?.data?.campaign?.timetable_unavailable === true
        setClasses(list)
        setConfigured(ok)
        setUnavailable(blip)
        onLoadedRef.current?.({ classes: list, configured: ok, unavailable: blip })
      })
      .catch(() => {
        if (!alive) return
        setClasses([])
        setUnavailable(true)
        onLoadedRef.current?.({ classes: [], configured: true, unavailable: true })
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [page, publicPath, campaign, reloadKey, enabled])

  return { classes, loading, configured, unavailable }
}

/**
 * @param {{ list: { classes: object[], loading: boolean, configured: boolean, unavailable: boolean },
 *   copy: object, chosen: object|null, onPick: (cls: object) => void, onContinue: (cls: object|null) => void,
 *   onSkip?: (() => void)|null, showClassName?: boolean, stepLabel?: string|null,
 *   ctaLabel: string, error?: string|null,
 *   title: import('react').ReactNode, body: import('react').ReactNode, reassurance?: string|null }} props
 */
export default function ClassPickStep({
  list, copy, chosen, onPick, onContinue, onSkip = null,
  showClassName = false, stepLabel = 'Step 1 of 2', ctaLabel, error = null,
  title, body, reassurance = null,
}) {
  const c = copy && typeof copy === 'object' ? copy : {}
  const { classes = [], loading = true, configured = true, unavailable = false } = list || {}
  const [showAll, setShowAll] = useState(false)
  // Day-first: the day in view (the one tapped, else the chosen slot's, else
  // the first). MOBILEFUNNEL.1: a tapped day wins over the chosen slot's, so
  // the day tiles still work with a class chosen (back from Change, or the
  // first slot preselected).
  const [dayPick, setDayPick] = useState(null)
  const dayRowRef = useRef(null)

  const groups = cadenceGroups(classes)
  const flat = groups.flatMap((g) => g.classes)
  const hiddenCount = showAll ? 0 : Math.max(0, flat.length - VISIBLE_TILES)
  const dayFirst = isDayFirst(groups)
  const chosenDay = chosen ? groups.find((g) => g.classes.some((c) => c.event_id === chosen.event_id))?.day : null
  const day = (groups.some((g) => g.day === dayPick) ? dayPick : null) || chosenDay || groups[0]?.day || null
  const daySlots = groups.find((g) => g.day === day)?.classes || []
  const empty = !loading && configured && (unavailable || flat.length === 0)
  // MOBILEFUNNEL.1 — the selected day stays in view in the sideways row,
  // when the list loads and whenever the day changes.
  useEffect(() => { if (dayFirst) keepSelectedInView(dayRowRef.current) }, [dayFirst, day, groups.length])
  // MOBILEFUNNEL.1 — a time tapped in the day-first shape is the choice and
  // the step forward in one; the class goes with the call.
  const pickAndContinue = (cls) => { onPick(cls); onContinue(cls) }
  const skip = onSkip && empty ? (
    <button type="button" onClick={onSkip} className={`${PICK_CTA_CLS} mt-4`}>{c.skip_class_label || 'Continue without picking a class'}</button>
  ) : null

  return (
    <>
      {stepLabel && <div className="text-[11px] uppercase tracking-[0.3em] font-semibold text-black/55">{stepLabel}</div>}
      <h2 className="font-display font-extrabold uppercase text-2xl sm:text-3xl mt-2 mb-2">{title}</h2>
      {body ? <p className="text-black/60 text-base mb-5">{body}</p> : null}
      {loading ? (
        <p className="text-black/50 text-base py-6 text-center">Checking the timetable…</p>
      ) : !configured ? (
        <p className="text-black/70 text-lg py-4" role="status">{c.not_configured_text}</p>
      ) : unavailable ? (
        <>
          {error && <p className="mt-2 text-sm text-red-700" role="alert">{error}</p>}
          <p className="text-black/70 text-lg py-4" role="status">{c.timetable_unavailable_text}</p>
          {skip}
        </>
      ) : flat.length === 0 ? (
        <>
          {error && <p className="mt-2 text-sm text-red-700" role="alert">{error}</p>}
          <p className="text-black/70 text-lg py-4" role="status">{c.no_classes_text}</p>
          {skip}
        </>
      ) : dayFirst ? (
        <>
          <div ref={dayRowRef} className={DAY_ROW_CLS} role="group" aria-label="Day">
            {groups.map((g) => <DayTile key={g.day} group={g} selected={g.day === day} onPick={setDayPick} />)}
          </div>
          <div className="mt-4 space-y-2" role="group" aria-label="Class">
            {daySlots.map((cls) => <SlotRow key={cls.event_id} cls={cls} selected={chosen?.event_id === cls.event_id} onPick={pickAndContinue} />)}
          </div>
          {error && <p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}
          {reassurance ? <p className="text-center text-sm text-black/55 mt-4">{reassurance}</p> : null}
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2.5">
            {flat.map((cls, i) => (
              <Tile key={cls.event_id} cls={cls} selected={chosen?.event_id === cls.event_id} onPick={onPick} beyondFirstRow={!showAll && i >= VISIBLE_TILES} showName={showClassName} />
            ))}
          </div>
          {hiddenCount > 0 && (
            <button type="button" onClick={() => setShowAll(true)} className="lg:hidden block mx-auto mt-3 text-sm underline text-black/60 hover:text-black">
              More dates ({hiddenCount})
            </button>
          )}
          {error && <p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}
          <button type="button" onClick={() => onContinue(chosen)} disabled={!chosen} className={`${PICK_CTA_CLS} mt-5`}>{ctaLabel}</button>
          {reassurance ? <p className="text-center text-sm text-black/55 mt-3">{reassurance}</p> : null}
        </>
      )}
    </>
  )
}
