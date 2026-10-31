'use client'

// LandingPageSettingsForm — block-based editor for the public
// /welcome page (Phase 3b, mig 128).
//
// Structure:
//   - blocks state (array of { id, type, ...content })
//   - DndContext + SortableContext wraps the list so blocks can be
//     dragged into any order
//   - Each block renders inside a SortableBlockCard with: drag
//     handle, type label, collapse/expand toggle, delete button,
//     and a per-type BlockEditPanel for the content fields
//   - "+ Add section" button at the bottom opens a picker over
//     BLOCK_TYPES; clicking a type appends a default block
//   - Save = PUT /api/landing-page-settings { blocks }
//
// The flat columns from Phase 2/3a (hero_headline, pillars, gallery,
// etc.) are NO LONGER read or written by this form. They stay on
// disk for rollback safety. Mig 128 backfilled the blocks column
// from those flat columns at migration time.
//
// Adding a new block type: register in src/lib/landing-page-blocks.js,
// add a case to BlockEditPanel below, and add a renderer to
// src/app/welcome/page.js. Three-file change.
//
// PAGES.1 — two modes, chosen by the `page` prop (pageMode):
//   - legacy (no `page`): a studio's landing_page_settings row, props
//     locationId / initialSettings / publicPath / membershipSource; Save =
//     PUT /api/landing-page-settings; preview /welcome/<path>?edit=1. The
//     studio pages still render from that table until PR3.
//   - page (`page`, `studios`, `canEdit`): a landing_pages row edited at
//     /settings/landing-page/<id>. Blocks and the logo / Instagram fields seed
//     from page.blocks and page.chrome; Save = PUT /api/landing-pages/<id>
//     { title, blocks, chrome } (the stored chrome with the form's fields over
//     it, never was_live); preview /<slug>?edit=1; PageHeaderCard above the
//     form holds the title, path, status and (studio page) terms copy. With
//     canEdit false every control is disabled and there is no Save.

import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { uploadLandingMedia, captureVideoPoster } from '@/lib/landing-media-upload'
import {
  DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors,
  closestCenter, DragOverlay,
} from '@dnd-kit/core'
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  verticalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Loader2, Save, AlertCircle, ImagePlus, X as XIcon, ExternalLink,
  Video, Trash2, ArrowUp, ArrowDown, GripVertical, Plus, ChevronDown,
  ChevronRight, Layers,
} from 'lucide-react'
import {
  BLOCK_TYPES, blocksOrDefault, newBlockOfType, setByPath, newBlockId, OFFER_DEFAULT,
} from '@/lib/landing-page-blocks'
import { buildTrialOptions } from '@/lib/glofox-trial-options'
import { centsToEuros, eurosToCents } from '@/lib/price-format'
import { DEFAULT_TIMETABLE_UNAVAILABLE_MESSAGE, DEFAULT_CLASS_FUNNEL_CTA_LABEL } from '@/lib/public-landing'
import { parseManualTimetable, DEFAULT_MIN_NOTICE_HOURS } from '@/lib/manual-timetable'
import { DEFAULT_MANUAL_CONFIRM_EMAIL } from '@/lib/manual-booking-confirm-copy'
import { DEFAULT_FUNNEL_TERMS_COPY, DEFAULT_FUNNEL_EMAIL_COPY } from '@/lib/un1t-online-funnel-copy'
import { PAID_TRIAL_ACCOUNT_EMAIL_DEFAULT } from '@/lib/paid-trial'
import { CAMPAIGN_FUNNEL_SECTIONS, CAMPAIGN_FUNNEL_COPY_DEFAULTS } from '@/lib/campaign-funnel'
import PageHeaderCard from '@/components/landing-pages/PageHeaderCard'
import OfferBlockEditor from '@/components/landing-pages/OfferBlockEditor'
import { offerTypeOfBlock } from '@/lib/landing-page-offers'
import { Field, Input, Textarea } from '@/components/landing-pages/fields'
import { storedChrome, termsForSave, pageEditSnapshot, pageSaveMessage } from '@/components/landing-pages/page-save'

// PostMessage namespace shared with src/components/landing-page/
// EditModeOverlay.jsx so the iframe and the parent only react to
// each other and ignore the noise from extensions / dev tools.
const MESSAGE_NAMESPACE = 'lp-editor'

// W1.S1b — `brand` is the studio's resolved brand ({ companyName, shortName },
// getLocationBranding on the server page): new blocks' consent defaults, the
// logo hints and the embed snippet's title name it, never a literal gym.
export default function LandingPageSettingsForm({
  locationId: legacyLocationId, membershipSource: legacyMembershipSource = null, initialSettings,
  availableBookingTypes, publicPath: legacyPublicPath = null, availableEvents = [], brand = null,
  page = null, studios = [], canEdit = true,
}) {
  // PAGES.1 — page mode (see the header). currentPage follows every answer
  // the API returns (save, rename, publish) so the slug and chrome stay fresh.
  const pageMode = Boolean(page)
  const [currentPage, setCurrentPage] = useState(page)
  const [title, setTitle] = useState(page?.title || '')
  const [terms, setTerms] = useState(() => ({ ...(page?.chrome?.un1t_terms || {}) }))
  const readOnly = pageMode && !canEdit
  const showPreview = !pageMode || page.kind !== 'studio'
  const locationId = pageMode ? page.primary_location_id || null : legacyLocationId
  const membershipSource = pageMode
    ? studios.find((s) => s.location_id === page.primary_location_id)?.membership_source || null
    : legacyMembershipSource
  const publicPath = pageMode ? null : legacyPublicPath
  const pageId = pageMode ? currentPage.id : null
  const seed = pageMode ? (page.chrome || {}) : initialSettings

  const brandName = (brand?.companyName || '').trim()
  const wordmarkText = (brand?.shortName || '').trim() || brandName
  // LP multi-page: the preview iframe + "View live" links point at the
  // SELECTED studio's public page when known (public_path from mig 227),
  // falling back to the generic /welcome for a single-studio install.
  // A page row previews at its own slug (Task 17 adds &studio=<path>).
  const previewSrc = pageMode ? `/${currentPage.slug}?edit=1` : publicPath ? `/welcome/${publicPath}?edit=1` : '/welcome?edit=1'
  const liveUrl = pageMode ? `/${currentPage.slug}` : publicPath ? `/${publicPath}` : '/welcome'
  // Seed from saved blocks; if none, blocksOrDefault returns the
  // starter set so the form is never blank on first open.
  const [blocks, setBlocks] = useState(() => blocksOrDefault(pageMode ? page.blocks : initialSettings?.blocks))
  // PAGES.1 — page mode: blocks[0] is the page's offer block, pinned (no
  // drag, move, copy or delete; edited through OfferBlockEditor). A page with
  // an offer whose first block is not one gets a notice instead.
  const pinnedOffer = pageMode && offerTypeOfBlock(blocks[0]?.type) !== null ? blocks[0] : null
  const offerMissing = pageMode && !pinnedOffer && Boolean(page.offer_type) && page.offer_type !== 'none'
  const sortableBlocks = pinnedOffer ? blocks.slice(1) : blocks
  // The studio rows, kept current by each row's own save (Task 17's preview
  // select reads `enabled` from them).
  const [studioRows, setStudioRows] = useState(studios)
  const onSaveStudio = useCallback((locId, { row }) => {
    setStudioRows((prev) => prev.map((s) => (s.location_id === locId ? { ...s, ...row } : s)))
  }, [])
  const [expanded, setExpanded] = useState(() => new Set(blocks.map((b) => b.id)))
  const [activeDragId, setActiveDragId] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  // FIFTYPLUS.1 — why the last "+ Add section" was refused (a second
  // campaign_funnel with the same key), shown under the picker.
  const [addNotice, setAddNotice] = useState(null)

  // Site chrome (mig 129) — logo lives outside the blocks array
  // because it always renders regardless of section ordering.
  // Width stored as string so the operator can clear/edit the
  // input mid-typing without it snapping to a default; coerced
  // on save (same pattern Staff required + Booking type forms use).
  const [logoUrl,     setLogoUrl]     = useState(seed?.logo_url || '')
  const [logoAlt,     setLogoAlt]     = useState(seed?.logo_alt || '')
  const [logoWidthPx, setLogoWidthPx] = useState(String(seed?.logo_width_px || ''))

  // EVENTS-IG.1 (mig 382) — flat column outside the blocks list, like the logo.
  // Absent → default ON; only an explicit false hides the events-page IG strip.
  const [showInstagramFeed, setShowInstagramFeed] = useState(seed?.show_instagram_feed !== false)

  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  // PAGES.1 — unsaved edits in page mode: everything Save sends, against
  // what was last saved (the first render's values until a save lands).
  // The header card holds the publish buttons back while it differs.
  const editSnapshot = pageMode
    ? pageEditSnapshot({ title, blocks, logoUrl, logoAlt, logoWidthPx, showInstagramFeed, terms })
    : null
  const [savedSnapshot, setSavedSnapshot] = useState(editSnapshot)
  const dirty = pageMode && editSnapshot !== savedSnapshot

  // Per-key upload spinner / error so multiple file inputs across
  // multiple blocks can show their own status without trampling.
  const [uploading, setUploading] = useState({}) // { key: bool }
  const [uploadErr, setUploadErr] = useState({}) // { key: string }
  const [progress, setProgress] = useState({}) // { key: { phase, percent } | null }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const blockIds = useMemo(() => sortableBlocks.map((b) => b.id), [sortableBlocks])
  const activeBlock = blocks.find((b) => b.id === activeDragId)

  // ── Live preview iframe (Phase 3c) ────────────────────────
  // Right-pane iframe loads /welcome?edit=1, which mounts the
  // EditModeOverlay client component. The overlay posts a 'ready'
  // message on mount; we respond with the current state and then
  // push every subsequent state change so typing in the form
  // updates the preview in near-realtime. The iframe also posts
  // 'block-clicked' when the operator clicks a block in the
  // preview — we expand + scroll-to that block's edit panel.
  const iframeRef = useRef(null)
  const cardRefs = useRef({})

  const buildState = useCallback(() => {
    let widthPxOrNull = null
    const parsed = parseInt(logoWidthPx, 10)
    if (Number.isFinite(parsed)) {
      widthPxOrNull = Math.min(600, Math.max(40, parsed))
    }
    return {
      namespace: MESSAGE_NAMESPACE,
      type: 'state',
      blocks,
      logoUrl: logoUrl.trim() || null,
      logoAlt: logoAlt.trim() || null,
      logoWidthPx: widthPxOrNull,
      // Mig 3c.3 — iframe needs locationId to attribute uploads
      // (EditableImage / HeroMediaTools call /api/landing-page-
      // settings/media which validates location ownership).
      locationId,
      // PAGES.1 — a page row's id, for its uploads (Task 18).
      ...(pageId ? { pageId } : {}),
    }
  }, [blocks, logoUrl, logoAlt, logoWidthPx, locationId, pageId])

  // Push state to the iframe whenever it changes. The iframe also
  // sends a 'ready' message on mount which we respond to immediately
  // (handled in the message listener below) — this useEffect covers
  // every keystroke after that.
  useEffect(() => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    try { win.postMessage(buildState(), window.location.origin) } catch { /* not loaded yet */ }
  }, [buildState])

  // Listen for messages from the iframe (block click → select).
  useEffect(() => {
    function onMessage(event) {
      if (event.origin !== window.location.origin) return
      const msg = event.data
      if (!msg || typeof msg !== 'object' || msg.namespace !== MESSAGE_NAMESPACE) return
      // PAGES.1 — read-only: the preview may be clicked, never edited.
      if (readOnly && msg.type !== 'ready' && msg.type !== 'block-clicked') return
      // PAGES.1 — the pinned offer block (page mode's blocks[0]) is never
      // moved, copied or deleted from the preview, and nothing goes above it.
      const pinnedIn = (list) => (pageMode && offerTypeOfBlock(list[0]?.type) !== null ? list[0].id : null)
      if (msg.type === 'ready') {
        // Send initial state right away.
        const win = iframeRef.current?.contentWindow
        if (win) try { win.postMessage(buildState(), window.location.origin) } catch { /* ignore */ }
      } else if (msg.type === 'block-clicked' && msg.blockId) {
        // Expand the clicked block + scroll its card into view.
        setExpanded((prev) => new Set(prev).add(msg.blockId))
        // Defer the scroll so the expanded panel has measured by the
        // time we ask the browser to scroll to it.
        setTimeout(() => {
          const el = cardRefs.current[msg.blockId]
          if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        }, 50)
      } else if (msg.type === 'edit-field' && msg.blockId && Array.isArray(msg.path)) {
        // Inline contentEditable in the iframe → apply the patch
        // to the corresponding block via setByPath. Each keystroke
        // arrives here; React's batched updates + EditableText's
        // focus-aware DOM write keep the cursor stable.
        setBlocks((prev) => prev.map((b) => (
          b.id === msg.blockId ? setByPath(b, msg.path, msg.value) : b
        )))
      } else if (msg.type === 'move-block' && msg.blockId && (msg.direction === 'up' || msg.direction === 'down')) {
        // LP3c.4 — toolbar move arrow on a block in the iframe.
        setBlocks((prev) => {
          const i = prev.findIndex((b) => b.id === msg.blockId)
          if (i < 0) return prev
          const j = msg.direction === 'up' ? i - 1 : i + 1
          if (j < 0 || j >= prev.length) return prev
          const pinned = pinnedIn(prev)
          if (pinned && (i === 0 || j === 0)) return prev
          const next = prev.slice()
          ;[next[i], next[j]] = [next[j], next[i]]
          return next
        })
      } else if (msg.type === 'duplicate-block' && msg.blockId) {
        // LP3c.4 — duplicate inserts a copy directly after the
        // source. Fresh id so React keys + future drag don't
        // collide; copy everything else verbatim.
        setBlocks((prev) => {
          const i = prev.findIndex((b) => b.id === msg.blockId)
          if (i < 0 || msg.blockId === pinnedIn(prev)) return prev
          const copy = JSON.parse(JSON.stringify(prev[i]))
          copy.id = newBlockId()
          const next = prev.slice()
          next.splice(i + 1, 0, copy)
          return next
        })
      } else if (msg.type === 'delete-block' && msg.blockId) {
        // LP3c.4 — toolbar trash on a block in the iframe.
        // Confirmation already happened in the iframe.
        setBlocks((prev) => (msg.blockId === pinnedIn(prev) ? prev : prev.filter((b) => b.id !== msg.blockId)))
        setExpanded((prev) => {
          const next = new Set(prev)
          next.delete(msg.blockId)
          return next
        })
      } else if (msg.type === 'add-block' && typeof msg.blockType === 'string' && typeof msg.atIndex === 'number') {
        // LP3c.4 — InsertGap pick from the iframe. atIndex is the
        // position the new block should occupy AFTER insertion
        // (0 = at top; blocks.length = at bottom; n = between
        // existing[n-1] and existing[n]).
        let added = null
        try { added = newBlockOfType(msg.blockType, { brand: brandName }) } catch { return }
        if (pageMode && offerTypeOfBlock(added.type) !== null) return
        setBlocks((prev) => {
          const idx = Math.max(pinnedIn(prev) ? 1 : 0, Math.min(prev.length, msg.atIndex))
          const next = prev.slice()
          next.splice(idx, 0, added)
          return next
        })
        // Auto-expand the freshly-added block in the form list so
        // the operator can immediately edit its content.
        setExpanded((prev) => new Set(prev).add(added.id))
      } else if (msg.type === 'edit-chrome' && typeof msg.field === 'string') {
        // LP3c.5 — site chrome (logo) swap from the iframe. Logo
        // isn't a block; chrome lives in flat columns on
        // landing_page_settings (mig 129). For now only the
        // logoUrl field is editable from the iframe — alt text +
        // width still go through the form on the left.
        if (msg.field === 'logoUrl')          setLogoUrl(msg.value || '')
        else if (msg.field === 'logoAlt')     setLogoAlt(msg.value || '')
        else if (msg.field === 'logoWidthPx') setLogoWidthPx(String(msg.value || ''))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [buildState, brandName, readOnly, pageMode])

  // ── Block ops ─────────────────────────────────────────────
  function updateBlock(id, patch) {
    setBlocks((prev) => prev.map((b) => b.id === id ? { ...b, ...patch } : b))
  }
  function removeBlock(id) {
    setBlocks((prev) => prev.filter((b) => b.id !== id))
    setExpanded((prev) => { const next = new Set(prev); next.delete(id); return next })
  }
  function addBlock(type) {
    const block = newBlockOfType(type, { brand: brandName })
    const refusal = campaignFunnelAddRefusal(blocks, block)
    if (refusal) { setAddNotice(refusal); return }
    setAddNotice(null)
    setBlocks((prev) => [...prev, block])
    setExpanded((prev) => new Set(prev).add(block.id))
    setPickerOpen(false)
  }
  function toggleExpanded(id) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // ── DnD handlers ──────────────────────────────────────────
  function handleDragStart(event) {
    setActiveDragId(event.active.id)
  }
  function handleDragEnd(event) {
    const { active, over } = event
    setActiveDragId(null)
    if (!over || active.id === over.id) return
    setBlocks((prev) => {
      const oldIndex = prev.findIndex((b) => b.id === active.id)
      const newIndex = prev.findIndex((b) => b.id === over.id)
      if (oldIndex === -1 || newIndex === -1) return prev
      return arrayMove(prev, oldIndex, newIndex)
    })
  }
  function handleDragCancel() { setActiveDragId(null) }

  // ── Uploads ───────────────────────────────────────────────
  function setUploadState(key, isUploading, err) {
    setUploading((prev) => ({ ...prev, [key]: isUploading }))
    setUploadErr((prev) => ({ ...prev, [key]: err || null }))
  }
  async function uploadMedia({ file, kind, key, autoplay = true }) {
    setUploadState(key, true, null)
    setProgress((prev) => ({ ...prev, [key]: null }))
    const res = await uploadLandingMedia({
      file,
      locationId,
      kind,
      autoplay,
      onProgress: (p) => setProgress((prev) => ({ ...prev, [key]: p })),
    })
    setProgress((prev) => ({ ...prev, [key]: null }))
    if (!res.success) {
      setUploadState(key, false, res.error || 'Upload failed')
      return null
    }
    setUploadState(key, false, null)
    return res.url
  }

  // ── Save ──────────────────────────────────────────────────
  async function handleSave(e) {
    e?.preventDefault?.()
    if (readOnly) return
    setError(null)
    setSaving(true)
    try {
      // Coerce + clamp logo width on save (the input keeps it as
      // a string so mid-edit empty state doesn't snap; clamp to
      // the same 40-600 range as the API + DB CHECK constraint).
      let widthPxOrNull = null
      const parsed = parseInt(logoWidthPx, 10)
      if (Number.isFinite(parsed)) {
        widthPxOrNull = Math.min(600, Math.max(40, parsed))
      }
      const chromeFields = {
        logo_url:      logoUrl.trim() || null,
        logo_alt:      logoAlt.trim() || null,
        logo_width_px: widthPxOrNull,
        show_instagram_feed: showInstagramFeed,
      }
      if (pageMode) {
        const sent = editSnapshot
        await savePage(chromeFields)
        setSavedSnapshot(sent)
      } else await saveLegacy(chromeFields)
      setSavedAt(new Date())
    } catch (err) {
      setError(err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // Legacy mode: the studio's landing_page_settings row.
  async function saveLegacy(chromeFields) {
    const r = await fetch('/api/landing-page-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_id: locationId, blocks, ...chromeFields }),
    })
    const j = await r.json()
    if (!r.ok || j.success === false) throw new Error(j.error || `Save failed (${r.status})`)
  }

  // PAGES.1 page mode: the landing_pages row. The stored chrome goes back
  // with the form's fields over it (was_live is the server's, never sent).
  async function savePage(chromeFields) {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) throw new Error('Give the page a title.')
    const chrome = { ...storedChrome(currentPage.chrome), ...chromeFields }
    if (currentPage.kind === 'studio') chrome.un1t_terms = termsForSave(terms)
    const r = await fetch(`/api/landing-pages/${currentPage.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: trimmedTitle, blocks, chrome }),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || j.success === false) throw new Error(pageSaveMessage(j, r.status))
    if (j.data) setCurrentPage(j.data)
  }

  const formEl = (
    <form onSubmit={handleSave} className="xl:grid xl:grid-cols-[minmax(0,520px)_minmax(0,1fr)] xl:gap-6 xl:items-start">
      {/* Left pane — block editor (the original form). On <xl
          screens this is the entire form; on xl+ it sits beside
          the live preview iframe. */}
      {/* PAGES.1 — a fieldset so read-only disables every control at once. */}
      <fieldset disabled={readOnly} className="min-w-0 space-y-4 xl:max-h-[calc(100vh-160px)] xl:overflow-y-auto xl:pr-2">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-3 inline-flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* Header — studio picker (multi-page) + preview + collapse/expand */}
      <div className="flex items-center justify-between gap-3 pb-2">
        <div className="flex items-center gap-3">
          <a
            href={liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300"
          >
            <ExternalLink size={13} /> Preview public page
          </a>
          <button
            type="button"
            onClick={() => setExpanded((prev) => prev.size === blocks.length ? new Set() : new Set(blocks.map(b => b.id)))}
            className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1"
          >
            <Layers size={12} /> {expanded.size === blocks.length ? 'Collapse all' : 'Expand all'}
          </button>
        </div>
        {savedAt && !saving && (
          <span className="text-xs text-emerald-700">Saved {savedAt.toLocaleTimeString('en-IE')}</span>
        )}
      </div>

      {/* Site header (mig 129) — chrome that always renders, lives
          OUTSIDE the blocks list because it doesn't move and the
          operator can't have more than one. */}
      <section className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Site header</h3>
          <p className="text-[11px] text-un1t-muted mt-1">Logo for the top nav. Renders on every page state regardless of section ordering.{wordmarkText
            ? <> Leave the logo blank to fall back to the &ldquo;{wordmarkText}&rdquo; wordmark text.</>
            : ' Leave the logo blank to fall back to the brand wordmark text.'}</p>
        </div>
        <Field label="Logo image" hint="PNG / JPEG / WebP — large images are auto-optimized on upload. Transparent PNG works best on the dark nav background.">
          <MediaSlot
            url={logoUrl}
            onClear={() => setLogoUrl('')}
            onUpload={async (file) => { const url = await uploadMedia({ file, kind: 'image', key: 'site-logo' }); if (url) setLogoUrl(url) }}
            uploading={!!uploading['site-logo']}
            error={uploadErr['site-logo']}
            accept="image/png,image/jpeg,image/webp"
            label="Add logo"
            kind="image"
          />
        </Field>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Alt text" hint={brandName ? `What screen readers announce. Defaults to “${brandName}” if blank.` : 'What screen readers announce. Defaults to the brand name if blank.'}>
            <Input value={logoAlt} onChange={setLogoAlt} maxLength={200} placeholder={brandName} />
          </Field>
          <Field label="Logo width (px)" hint="40-600. Defaults to 200px. Width drives the rendered size — height auto-follows the image's aspect ratio. Bump it up for a chunky wordmark, down for a square brand mark.">
            <input
              type="number"
              min={40}
              max={600}
              step={10}
              value={logoWidthPx}
              onChange={(e) => setLogoWidthPx(e.target.value)}
              placeholder="200"
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
          </Field>
        </div>
      </section>

      {/* Instagram strip (EVENTS-IG.1) — flat toggle outside the blocks list,
          gating the carousel of latest posts on the public events page. */}
      <section className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Instagram</h3>
        </div>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={showInstagramFeed}
            onChange={(e) => setShowInstagramFeed(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="block text-sm text-un1t-text">Show Instagram posts on the events page</span>
            <span className="block text-[11px] text-un1t-muted mt-0.5">Latest posts from your connected Instagram account. Turn off to hide the strip.</span>
          </span>
        </label>
      </section>

      {/* PAGES.1 — page mode: the pinned offer block, above the sortable list. */}
      {offerMissing && (
        <p role="note" className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700">This page&apos;s offer block is missing. Ask the team.</p>
      )}
      {pinnedOffer && (
        <div ref={(el) => { if (el) cardRefs.current[pinnedOffer.id] = el }}>
          <PinnedOfferCard
            block={pinnedOffer}
            expanded={expanded.has(pinnedOffer.id)}
            onToggleExpand={() => toggleExpanded(pinnedOffer.id)}
          >
            <OfferBlockEditor
              page={currentPage}
              block={pinnedOffer}
              studios={studioRows}
              onUpdateBlock={(patch) => updateBlock(pinnedOffer.id, patch)}
              onSaveStudio={onSaveStudio}
              canEdit={canEdit}
              locationId={locationId}
              membershipSource={membershipSource}
              uploadMedia={uploadMedia}
              uploading={uploading}
              uploadErr={uploadErr}
              progress={progress}
            />
          </PinnedOfferCard>
        </div>
      )}

      {/* Sortable block list */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={blockIds} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {sortableBlocks.map((block) => (
              // The wrapper div carries the cardRef target so the
              // iframe-click → scroll-to-card behaviour can find it.
              // SortableBlockCard's own outer div is the @dnd-kit
              // setNodeRef target, so we wrap it rather than thread
              // a second ref through.
              <div
                key={block.id}
                ref={(el) => { if (el) cardRefs.current[block.id] = el }}
              >
                <SortableBlockCard
                  block={block}
                  expanded={expanded.has(block.id)}
                  onToggleExpand={() => toggleExpanded(block.id)}
                  onRemove={() => removeBlock(block.id)}
                  onUpdate={(patch) => updateBlock(block.id, patch)}
                  availableBookingTypes={availableBookingTypes}
                  availableEvents={availableEvents}
                  brandName={brandName}
                  uploadMedia={uploadMedia}
                  uploading={uploading}
                  uploadErr={uploadErr}
                  progress={progress}
                  locationId={locationId}
                  membershipSource={membershipSource}
                  publicPath={publicPath}
                />
              </div>
            ))}
          </div>
        </SortableContext>
        <DragOverlay>
          {activeBlock ? (
            <div className="bg-un1t-surface border border-un1t-muted rounded-lg p-3 shadow-2xl opacity-90">
              <div className="flex items-center gap-2 text-sm text-un1t-text">
                <GripVertical size={14} /> {labelFor(activeBlock.type)}
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Add-section picker */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="w-full bg-un1t-surface border-2 border-dashed border-un1t-border hover:border-un1t-muted rounded-lg py-3 text-sm text-un1t-subtle hover:text-un1t-text inline-flex items-center justify-center gap-2"
        >
          <Plus size={14} /> Add section
        </button>
        {addNotice && <p className="mt-2 text-xs text-red-700" role="alert">{addNotice}</p>}
        {pickerOpen && (
          <div className="absolute z-30 left-0 right-0 mt-2 bg-un1t-surface border border-un1t-border rounded-lg shadow-xl p-2 grid grid-cols-1 md:grid-cols-2 gap-1">
            {BLOCK_TYPES.filter((t) => !pageMode || !t.offer).map((t) => (
              <button
                key={t.type}
                type="button"
                onClick={() => addBlock(t.type)}
                className="text-left p-3 rounded-md hover:bg-un1t-border/40 transition-colors"
              >
                <div className="text-sm font-semibold text-un1t-text">{t.label}</div>
                <div className="text-[11px] text-un1t-muted mt-0.5">{t.description}</div>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              className="md:col-span-2 text-[11px] text-un1t-muted hover:text-un1t-subtle pt-2 mt-1 border-t border-un1t-border"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Sticky save bar (lives inside the left pane so it sits
          under the form scroll, not the iframe). */}
      <div className="sticky bottom-4 flex items-center justify-end gap-2 bg-un1t-surface/80 backdrop-blur border border-un1t-border rounded-md p-3">
        <a
          href={liveUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1.5"
        >
          <ExternalLink size={12} /> Preview
        </a>
        {!readOnly && (
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 bg-un1t-text text-un1t-bg font-semibold text-sm py-2 px-4 rounded-md hover:bg-un1t-accent disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        )}
      </div>
      </fieldset>
      {/* ── Right pane — live preview iframe (xl+ screens only) ─
          Loads /welcome?edit=1, which mounts EditModeOverlay and
          re-renders from the postMessage state we push from
          buildState() above. Click any block in the iframe →
          its edit panel auto-expands + scrolls into view in the
          left pane. */}
      {/* PAGES.1 — a studio page row renders from the legacy table until
          PR3, so its preview would show other content: a note instead. */}
      {!showPreview && (
        <aside className="hidden xl:block xl:sticky xl:top-4 border border-un1t-border rounded-lg bg-un1t-surface p-4 text-sm text-un1t-subtle">
          The preview shows here once studio pages move to this editor.
        </aside>
      )}
      {showPreview && (
      <aside className="hidden xl:block xl:sticky xl:top-4">
        <div className="border border-un1t-border rounded-lg overflow-hidden bg-un1t-bg">
          <div className="flex items-center justify-between px-3 py-2 bg-un1t-surface border-b border-un1t-border text-[11px] text-un1t-subtle">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              Live preview · click a section to edit
            </span>
            <button
              type="button"
              onClick={() => { try { iframeRef.current?.contentWindow?.location?.reload() } catch { /* cross-origin guard */ } }}
              className="text-un1t-muted hover:text-un1t-text"
              title="Reload preview"
            >
              ⟳
            </button>
          </div>
          <iframe
            ref={iframeRef}
            src={previewSrc}
            title="Welcome page live preview"
            className="w-full"
            style={{ height: 'calc(100vh - 200px)', minHeight: '600px' }}
          />
        </div>
      </aside>
      )}
    </form>
  )

  if (!pageMode) return formEl
  return (
    <div className="space-y-4">
      <PageHeaderCard
        page={currentPage} studios={studioRows} canEdit={canEdit}
        title={title} onTitleChange={setTitle} onPageChange={setCurrentPage}
        terms={terms} onTermsChange={setTerms} dirty={dirty}
      />
      {formEl}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// SortableBlockCard — wraps each block with drag handle, header
// (type label + expand/delete), and the per-type edit panel below.
// ─────────────────────────────────────────────────────────────

function SortableBlockCard({
  block, expanded, onToggleExpand, onRemove, onUpdate,
  availableBookingTypes, availableEvents, uploadMedia, uploading, uploadErr, progress,
  locationId, membershipSource, publicPath, brandName,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Hide the original while dragging — DragOverlay shows the
    // floating ghost so the page doesn't have two cards mid-drag.
    opacity: isDragging ? 0 : 1,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden"
    >
      <div className="flex items-center gap-2 p-3">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Drag ${labelFor(block.type)}`}
          className="cursor-grab active:cursor-grabbing text-un1t-muted hover:text-un1t-text touch-none"
          title="Drag to reorder"
        >
          <GripVertical size={16} />
        </button>
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex-1 flex items-center gap-2 text-left min-w-0"
        >
          {expanded ? <ChevronDown size={14} className="text-un1t-muted" /> : <ChevronRight size={14} className="text-un1t-muted" />}
          <span className="text-sm font-semibold text-un1t-text">{labelFor(block.type)}</span>
          <span className="text-[11px] text-un1t-muted truncate">{summaryFor(block)}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirm(`Remove this ${labelFor(block.type)} section?`)) onRemove()
          }}
          aria-label="Delete section"
          className="text-un1t-muted hover:text-red-400 p-1"
          title="Delete section"
        >
          <Trash2 size={14} />
        </button>
      </div>
      {expanded && (
        <div className="border-t border-un1t-border p-4 space-y-3">
          <BlockEditPanel
            block={block}
            onUpdate={onUpdate}
            availableBookingTypes={availableBookingTypes}
            availableEvents={availableEvents}
            brandName={brandName}
            uploadMedia={uploadMedia}
            uploading={uploading}
            uploadErr={uploadErr}
            progress={progress}
            locationId={locationId}
            membershipSource={membershipSource}
            publicPath={publicPath}
          />
        </div>
      )}
    </div>
  )
}

// PAGES.1 — the page's offer block in page mode: no drag handle, no delete,
// a "Pinned" label beside the type's label; its body is OfferBlockEditor.
function PinnedOfferCard({ block, expanded, onToggleExpand, children }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 p-3">
        <button type="button" onClick={onToggleExpand} className="flex-1 flex items-center gap-2 text-left min-w-0">
          {expanded ? <ChevronDown size={14} className="text-un1t-muted" /> : <ChevronRight size={14} className="text-un1t-muted" />}
          <span className="text-sm font-semibold text-un1t-text">{labelFor(block.type)}</span>
          <span className="text-[11px] font-medium rounded-full px-2 py-0.5 bg-gray-500/10 text-gray-700">Pinned</span>
        </button>
      </div>
      {expanded && <div className="border-t border-un1t-border p-4 space-y-3">{children}</div>}
    </div>
  )
}

function labelFor(type) {
  return BLOCK_TYPES.find((t) => t.type === type)?.label || type
}

function summaryFor(block) {
  switch (block.type) {
    case 'hero':        return block.headline || ''
    case 'booking':     return block.slug ? `slug: ${block.slug}` : ''
    case 'event':       return block.slug ? `event: ${block.slug}` : 'no event'
    case 'lead_form':   return block.heading || 'Waitlist'
    case 'class_funnel': {
      let base = block.consult_slug ? `consult: ${block.consult_slug}` : 'no consult upsell'
      if (block.trial_membership_id) base = `${base} · trial set`
      if (Number(block.price_cents) > 0) base = `${base} · €${centsToEuros(block.price_cents)}`
      return base
    }
    case 'pillars':     return `${(block.items || []).length} items`
    case 'gallery':     return `${(block.items || []).length} photo${(block.items || []).length === 1 ? '' : 's'}`
    case 'embed':       return block.url ? new URL(block.url).hostname.replace(/^www\./, '') : 'no URL'
    case 'stats':       return `${(block.items || []).length} stats`
    case 'testimonial': return block.author || ''
    case 'reviews':     return block.title || ''
    case 'video_testimonials': {
      const n = (block.items || []).filter((it) => it && it.video_url).length
      return `${n} video${n === 1 ? '' : 's'}`
    }
    case 'campaign_funnel': return `/${block.campaign || '?'} · ${block.trial_membership_id && block.trial_plan_code ? 'trial set' : 'NO TRIAL SET'}`
    default:            return ''
  }
}

// FIFTYPLUS.1 — one campaign_funnel per campaign key on a row: its page reads
// the FIRST block for the key, so a second would be edited and never shown.
// Exported for its test (CampaignFunnelEdit.test.jsx).
export function campaignFunnelAddRefusal(blocks, block) {
  if (!block || block.type !== 'campaign_funnel') return null
  const dup = (Array.isArray(blocks) ? blocks : []).some((b) => b && b.type === 'campaign_funnel' && b.campaign === block.campaign)
  return dup ? `This page already has a campaign funnel for /${block.campaign}. Edit that one instead.` : null
}

// ─────────────────────────────────────────────────────────────
// BlockEditPanel — type-dispatch to the right edit form.
// ─────────────────────────────────────────────────────────────

function BlockEditPanel(props) {
  switch (props.block.type) {
    case 'hero':        return <HeroEdit        {...props} />
    case 'booking':     return <BookingEdit     {...props} />
    case 'event':       return <EventEdit       {...props} />
    case 'lead_form':   return <LeadFormEdit    {...props} />
    case 'class_funnel': return <ClassFunnelEdit {...props} />
    case 'paid_trial':  return <PaidTrialEdit   {...props} />
    case 'campaign_funnel': return <CampaignFunnelEdit {...props} />
    case 'corp_promo':  return <CorpPromoEdit   {...props} />
    case 'pillars':     return <PillarsEdit     {...props} />
    case 'gallery':     return <GalleryEdit     {...props} />
    case 'embed':       return <EmbedEdit       {...props} />
    case 'stats':       return <StatsEdit       {...props} />
    case 'testimonial': return <TestimonialEdit {...props} />
    case 'reviews':     return <ReviewsEdit     {...props} />
    case 'video_testimonials': return <VideoTestimonialsEdit {...props} />
    default:            return <div className="text-xs text-red-700">Unknown block type: {props.block.type}</div>
  }
}

function HeroEdit({ block, onUpdate, uploadMedia, uploading, uploadErr, progress }) {
  const k = (suffix) => `${block.id}-${suffix}`
  return (
    <>
      <Field label="Eyebrow" hint='Small uppercase line above the headline.'>
        <Input value={block.eyebrow || ''} onChange={(v) => onUpdate({ eyebrow: v })} maxLength={200} />
      </Field>
      <Field label="Headline (line 1)">
        <Input value={block.headline || ''} onChange={(v) => onUpdate({ headline: v })} maxLength={400} />
      </Field>
      <Field label="Headline (line 2)" hint="Renders in muted white for contrast.">
        <Input value={block.subhead || ''} onChange={(v) => onUpdate({ subhead: v })} maxLength={400} />
      </Field>
      <Field label="Subtext" hint="Paragraph under the headline.">
        <Textarea value={block.subtext || ''} onChange={(v) => onUpdate({ subtext: v })} maxLength={2000} rows={3} />
      </Field>
      <Field label="Background image" hint="PNG / JPEG / WebP — large images are auto-optimized on upload. Replaces the dark gradient. The video below takes precedence; the image then becomes its poster (still frame while video loads).">
        <MediaSlot
          url={block.image_url || ''}
          onClear={() => onUpdate({ image_url: null })}
          onUpload={async (file) => { const url = await uploadMedia({ file, kind: 'image', key: k('image') }); if (url) onUpdate({ image_url: url }) }}
          uploading={!!uploading[k('image')]}
          error={uploadErr[k('image')]}
          accept="image/png,image/jpeg,image/webp"
          label="Add image"
          kind="image"
        />
      </Field>
      <Field label="Background video" hint="MP4 / WebM / MOV, ≤ 50MB — autoplays muted on loop, so keep it short (compressed automatically where supported). Tip: 720p, 5-15 seconds.">
        <MediaSlot
          url={block.video_url || ''}
          onClear={() => onUpdate({ video_url: null })}
          onUpload={async (file) => { const url = await uploadMedia({ file, kind: 'video', key: k('video') }); if (url) onUpdate({ video_url: url }) }}
          uploading={!!uploading[k('video')]}
          error={uploadErr[k('video')]}
          accept="video/mp4,video/webm"
          label="Add video"
          kind="video"
          progress={progress[k('video')]}
        />
      </Field>
    </>
  )
}

function BookingEdit({ block, onUpdate, availableBookingTypes }) {
  return (
    <Field label="Booking type" hint={availableBookingTypes.length === 0 ? 'No active booking types found. Create one under Bookings → Booking types first.' : 'Pick the booking type whose form embeds.'}>
      {availableBookingTypes.length > 0 ? (
        <select
          value={block.slug || ''}
          onChange={(e) => onUpdate({ slug: e.target.value })}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
        >
          <option value="">— Pick a booking type —</option>
          {availableBookingTypes.map((bt) => (
            <option key={bt.id} value={bt.slug}>{bt.name} ({bt.slug})</option>
          ))}
          {block.slug && !availableBookingTypes.some((bt) => bt.slug === block.slug) && (
            <option value={block.slug}>{block.slug} (no longer active)</option>
          )}
        </select>
      ) : (
        <Input value={block.slug || ''} onChange={(v) => onUpdate({ slug: v })} maxLength={200} placeholder="consultation" />
      )}
    </Field>
  )
}

function EventEdit({ block, onUpdate, availableEvents, brandName = '' }) {
  const events = availableEvents || []
  const origin = (typeof window !== 'undefined' && window.location?.origin) || 'https://un1tdublin.com'
  const snippet = block.slug
    ? `<iframe src="${origin}/embed/event/${block.slug}" width="100%" height="900" style="border:0;max-width:760px" loading="lazy" title="${escapeAttr(brandName ? `${brandName} event signup` : 'Event signup')}"></iframe>`
    : ''
  return (
    <>
      <Field label="Event" hint={events.length === 0 ? 'No active events at this studio. Create one under Events first.' : "Which event's signup form to embed on this page."}>
        {events.length > 0 ? (
          <select
            value={block.slug || ''}
            onChange={(e) => onUpdate({ slug: e.target.value })}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
          >
            <option value="">— Pick an event —</option>
            {events.map((ev) => (
              <option key={ev.slug} value={ev.slug}>{ev.name}</option>
            ))}
            {block.slug && !events.some((ev) => ev.slug === block.slug) && (
              <option value={block.slug}>{block.slug} (no longer active)</option>
            )}
          </select>
        ) : (
          <Input value={block.slug || ''} onChange={(v) => onUpdate({ slug: v })} maxLength={200} placeholder="event-slug" />
        )}
      </Field>
      <Field label="Heading" hint="Optional title shown above the signup form.">
        <Input value={block.title || ''} onChange={(v) => onUpdate({ title: v })} maxLength={200} placeholder="Sign up" />
      </Field>
      {block.slug && (
        <Field label="Embed on another website" hint="Paste this into any external site (WordPress, Squarespace, a partner page) to show this event's signup form there.">
          <textarea
            readOnly
            value={snippet}
            onFocus={(e) => e.target.select()}
            rows={3}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-[11px] font-mono text-un1t-subtle"
          />
        </Field>
      )}
    </>
  )
}

function LeadFormEdit({ block, onUpdate }) {
  // The offer group is nested, and updateBlock() shallow-merges the
  // patch into the block — so every offer edit must spread the whole
  // current group or it would drop the other fields.
  const offer = (block.offer && typeof block.offer === 'object' && !Array.isArray(block.offer)) ? block.offer : {}
  const setOffer = (patch) => onUpdate({ offer: { ...offer, ...patch } })
  const ticks = Array.isArray(offer.ticks) ? offer.ticks : []
  const setTick = (i, v) => {
    const next = [ticks[0] || '', ticks[1] || '', ticks[2] || '']
    next[i] = v
    setOffer({ ticks: next })
  }
  return (
    <>
      <Field label="Heading">
        <Input value={block.heading || ''} onChange={(v) => onUpdate({ heading: v })} maxLength={200} placeholder="Keep me posted" />
      </Field>
      <Field label="Sub-copy" hint="Paragraph under the heading.">
        <Textarea value={block.subtext || ''} onChange={(v) => onUpdate({ subtext: v })} maxLength={600} rows={3} />
      </Field>
      <Field label="Button label">
        <Input value={block.button_label || ''} onChange={(v) => onUpdate({ button_label: v })} maxLength={60} placeholder="Keep me posted" />
      </Field>
      <Field label="Success message" hint="Shown after a successful submit.">
        <Textarea value={block.success_message || ''} onChange={(v) => onUpdate({ success_message: v })} maxLength={300} rows={2} />
      </Field>
      <Field label="Consent checkbox text" hint="Shown beside the opt-in checkbox. Keep it explicit for GDPR — name the channels (email/SMS/WhatsApp).">
        <Textarea value={block.consent_label || ''} onChange={(v) => onUpdate({ consent_label: v })} maxLength={400} rows={3} />
      </Field>
      <Field
        label="Panel beside the offer"
        hint="Only applies while the offer below is on. The class-funnel button needs that funnel shown on this page; if it is hidden, the form stays."
      >
        <select
          value={block.second_path === 'class_funnel' ? 'class_funnel' : 'form'}
          onChange={(e) => onUpdate({ second_path: e.target.value })}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
        >
          <option value="form">This form (heading, sub-copy, button)</option>
          <option value="class_funnel">Button to the class booking funnel (heading and sub-copy still show)</option>
        </select>
      </Field>

      <div className="pt-4 mt-2 border-t border-un1t-border">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={offer.enabled === true}
            onChange={(e) => setOffer(
              // Seed the defaults on the way ON, so a block saved
              // before this group existed doesn't open a blank panel.
              // The operator's own values win over the defaults, and
              // turning it OFF keeps their copy for next time.
              e.target.checked ? { ...OFFER_DEFAULT(), ...offer, enabled: true } : { enabled: false }
            )}
            className="mt-0.5"
          />
          <span>
            <span className="block text-sm text-un1t-text">Show a membership offer beside this form</span>
            <span className="block text-[11px] text-un1t-muted mt-0.5">Adds a price panel to the left of the form and points the hero&apos;s main button at it. Untick when the offer closes and the section goes back to the form on its own.</span>
          </span>
        </label>
      </div>

      {offer.enabled === true && (
        <>
          <Field label="Section eyebrow">
            <Input value={offer.section_eyebrow || ''} onChange={(v) => setOffer({ section_eyebrow: v })} maxLength={60} placeholder="Two ways in" />
          </Field>
          <Field label="Section heading" hint="Line breaks are kept exactly as you type them.">
            <Textarea value={offer.section_heading || ''} onChange={(v) => setOffer({ section_heading: v })} maxLength={200} rows={2} placeholder={'Fix your rate\nbefore we open'} />
          </Field>
          <Field label="Offer label">
            <Input value={offer.eyebrow || ''} onChange={(v) => setOffer({ eyebrow: v })} maxLength={60} placeholder="Foundation membership" />
          </Field>
          <Field label="Price">
            <Input value={offer.price || ''} onChange={(v) => setOffer({ price: v })} maxLength={20} placeholder="€189" />
          </Field>
          <Field label="Struck-out price" hint="Shown with a red line through it, left of the price. Leave empty for no strike.">
            <Input value={offer.was_price || ''} onChange={(v) => setOffer({ was_price: v })} maxLength={20} placeholder="€219" />
          </Field>
          <Field label="Struck-out price, spoken" hint="Screen readers only. A struck price on its own is heard as “it used to be €219”, so say which way it goes.">
            <Input value={offer.was_price_note || ''} onChange={(v) => setOffer({ was_price_note: v })} maxLength={120} placeholder="a month from 19 September" />
          </Field>
          <Field label="Price caption" hint="Line breaks are kept exactly as you type them.">
            <Textarea value={offer.unit || ''} onChange={(v) => setOffer({ unit: v })} maxLength={80} rows={2} placeholder={'per month\nfixed for life'} />
          </Field>
          <Field label="Deadline chip" hint="Small pill in the corner of the panel. Leave empty to hide it.">
            <Input value={offer.deadline || ''} onChange={(v) => setOffer({ deadline: v })} maxLength={60} placeholder="Offer ends 19 September" />
          </Field>
          <Field label="What's included — line 1">
            <Input value={ticks[0] || ''} onChange={(v) => setTick(0, v)} maxLength={120} placeholder="Unlimited classes, full access from day one" />
          </Field>
          <Field label="What's included — line 2">
            <Input value={ticks[1] || ''} onChange={(v) => setTick(1, v)} maxLength={120} placeholder="Your rate never rises while your membership stays active" />
          </Field>
          <Field label="What's included — line 3">
            <Input value={ticks[2] || ''} onChange={(v) => setTick(2, v)} maxLength={120} placeholder="Pay today, next payment October" />
          </Field>
          <Field label="Offer button label">
            <Input value={offer.cta_label || ''} onChange={(v) => setOffer({ cta_label: v })} maxLength={60} placeholder="Claim your rate" />
          </Field>
          <Field label="Offer button label — short" hint="Used by the sticky header only, where a long label gets cut off on phones. Leave empty to reuse the full label.">
            <Input value={offer.cta_label_short || ''} onChange={(v) => setOffer({ cta_label_short: v })} maxLength={30} placeholder="Foundation Offer" />
          </Field>
          <Field label="Offer button link" hint="Where the button sends people to pay. Leave empty and the button is hidden rather than dead.">
            <Input value={offer.cta_url || ''} onChange={(v) => setOffer({ cta_url: v })} maxLength={500} placeholder="https://hatchstreet.un1t.online/#join" />
          </Field>
        </>
      )}
    </>
  )
}

// MANUALFUNNEL.1 — for a studio with no Glofox (Hatch Street books on its own
// platform). The operator types the weekly timetable; the funnel lists it,
// and every request lands in Approvals for staff to book by hand. A studio
// WITH Glofox ignores all of this and keeps listing its live classes; a
// un1t.online studio lists its synced classes instead of the typed text
// (HATCHSTART.1) but keeps the notice and the confirmation email.
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// PAGES.1 — `pageOnly` (page mode): the timetable, first date and notice are
// the studio rows' (StudioOfferRow); the confirmation email stays here.
function ManualTimetableFields({ block, onUpdate, publicPath, pageOnly = false }) {
  const text = typeof block.timetable === 'string' ? block.timetable : ''
  const { slots, rejected } = useMemo(() => parseManualTimetable(text), [text])
  const byDay = DAY_NAMES.map((name, i) => ({ name, times: slots.filter((s) => s.dow === i + 1) }))
    .filter((d) => d.times.length > 0)
  return (
    <div className="pt-4 mt-2 border-t border-un1t-border space-y-4">
      {pageOnly && (
        <p className="text-[11px] text-un1t-muted">Each studio&apos;s typed-in timetable, first bookable date and minimum notice are on its row below. The confirmation email is the same for every studio.</p>
      )}
      {!pageOnly && (<>
      <div>
        <p className="text-sm font-medium text-un1t-text">Typed-in timetable (studio without Glofox)</p>
        <p className="text-[11px] text-un1t-muted mt-1">
          Only used when this studio has no Glofox connection. Visitors pick one of these times and leave their details. Nothing is booked automatically: each request appears in Approvals for staff to create the account and booking by hand.
        </p>
        <p className="text-[11px] text-un1t-muted mt-1">
          A studio that runs on un1t.online ignores the typed-in timetable and the first bookable date: visitors see its real classes from un1t.online. The minimum notice and the confirmation email below still apply.
        </p>
      </div>
      <Field
        label="Weekly timetable"
        hint="One line per class: day, time, class name. Several days or times can share a line, e.g. “Mon-Fri 06:15, 07:15 Strength” or “Sat 9am Conditioning”."
      >
        <Textarea
          value={text}
          onChange={(v) => onUpdate({ timetable: v })}
          maxLength={4000}
          rows={8}
          placeholder={'Mon-Fri 06:15 Strength\nMon-Fri 18:00 Conditioning\nSat 09:00 Strength'}
        />
        {text.trim() && (
          <div className="mt-2 rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-xs text-un1t-text space-y-1">
            {byDay.length === 0 ? (
              <p className="text-red-700">No class times could be read yet.</p>
            ) : (
              <>
                <p className="text-un1t-subtle">How it reads ({slots.length} class {slots.length === 1 ? 'time' : 'times'} a week):</p>
                {byDay.map((d) => (
                  <p key={d.name}>
                    <span className="font-medium">{d.name}</span>{' '}
                    {d.times.map((s) => `${s.time} ${s.name}`).join(' · ')}
                  </p>
                ))}
              </>
            )}
            {rejected.length > 0 && (
              <div className="text-red-700 pt-1">
                <p>Not understood, so not shown to visitors:</p>
                {rejected.map((line, i) => <p key={`${i}-${line}`} className="font-mono">{line}</p>)}
              </div>
            )}
          </div>
        )}
      </Field>
      <Field label="First bookable date" hint="Optional. No class before this date is offered, e.g. the studio's opening day.">
        <input
          type="date"
          value={block.timetable_start_date || ''}
          onChange={(e) => onUpdate({ timetable_start_date: e.target.value })}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
        />
      </Field>
      <Field label="Minimum notice (hours)" hint={`A class starting sooner than this is not offered, so staff have time to book it by hand. Blank = ${DEFAULT_MIN_NOTICE_HOURS} hours.`}>
        <Input
          value={block.min_notice_hours === 0 ? '0' : (block.min_notice_hours || '')}
          onChange={(v) => {
            const t = v.trim()
            const n = Number(t)
            onUpdate({ min_notice_hours: t === '' || !Number.isFinite(n) || n < 0 ? '' : n })
          }}
          maxLength={3}
          placeholder={String(DEFAULT_MIN_NOTICE_HOURS)}
        />
      </Field>
      </>)}
      {/* MANUALCONFIRM.1 — the email the customer gets when staff approve. */}
      <Field label="Confirmation email subject" hint="Sent when staff approve a request. You can use {first_name}, {class_name}, {class_time}, {studio_name} and {address}. Blank keeps the default.">
        <Input value={block.confirm_email_subject || ''} onChange={(v) => onUpdate({ confirm_email_subject: v })} maxLength={150} placeholder={DEFAULT_MANUAL_CONFIRM_EMAIL.subject} />
      </Field>
      <Field label="Confirmation email body" hint="Plain text; line breaks are kept. Same placeholders as the subject. Blank keeps the default.">
        <Textarea value={block.confirm_email_body || ''} onChange={(v) => onUpdate({ confirm_email_body: v })} maxLength={2000} rows={8} placeholder={DEFAULT_MANUAL_CONFIRM_EMAIL.body} />
      </Field>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={block.show_on_landing !== false}
          onChange={(e) => onUpdate({ show_on_landing: e.target.checked })}
          className="mt-0.5"
        />
        <span>
          <span className="block text-sm text-un1t-text">Show this funnel on the main landing page</span>
          <span className="block text-[11px] text-un1t-muted mt-0.5">
            Untick to keep it off this page. It always shows on its own booking page{publicPath ? `: /start/${publicPath}` : ' at /start/ followed by this page’s address'}.
          </span>
        </span>
      </label>
    </div>
  )
}

// UN1TWRITE.18 — the terms and waiver tick a un1t.online studio's funnel
// shows while its funnel switch is on. Blank keeps each default.
function Un1tFunnelCopyFields({ block, onUpdate }) {
  const D = DEFAULT_FUNNEL_TERMS_COPY
  return (
    <>
      <Field label="Terms tick (un1t.online studios)" hint="Shown when this studio books through un1t.online. {studio_name} is the studio; {terms} and {waiver} become the two document links. Leave blank for the default.">
        <Input value={block.terms_label || ''} onChange={(v) => onUpdate({ terms_label: v })} maxLength={200} placeholder={D.terms_label} />
      </Field>
      <Field label="Terms link text (un1t.online studios)">
        <Input value={block.terms_link_label || ''} onChange={(v) => onUpdate({ terms_link_label: v })} maxLength={60} placeholder={D.terms_link_label} />
      </Field>
      <Field label="Waiver link text (un1t.online studios)">
        <Input value={block.waiver_link_label || ''} onChange={(v) => onUpdate({ waiver_link_label: v })} maxLength={60} placeholder={D.waiver_link_label} />
      </Field>
      <Field label="Terms not ticked: message (un1t.online studios)">
        <Input value={block.terms_required_message || ''} onChange={(v) => onUpdate({ terms_required_message: v })} maxLength={200} placeholder={D.terms_required_message} />
      </Field>
      {/* UN1TWRITE.21 — the un1t.online funnel's two customer emails. */}
      <Field label="New account email: subject (un1t.online studios)" hint="Sent when a booking made a new un1t.online account. {first_name} {class_name} {class_time} {studio_name} {address}. Leave blank for the default.">
        <Input value={block.account_email_subject || ''} onChange={(v) => onUpdate({ account_email_subject: v })} maxLength={150} placeholder={DEFAULT_FUNNEL_EMAIL_COPY.account_email_subject} />
      </Field>
      <Field label="New account email: message (un1t.online studios)">
        <Textarea value={block.account_email_body || ''} onChange={(v) => onUpdate({ account_email_body: v })} maxLength={2000} rows={6} placeholder={DEFAULT_FUNNEL_EMAIL_COPY.account_email_body} />
      </Field>
      <Field label="Trial already used email: subject (un1t.online studios)" hint="Sent when someone has had the free trial, so nothing was booked. {options} is the studio's offer list. Leave blank for the default.">
        <Input value={block.trial_used_email_subject || ''} onChange={(v) => onUpdate({ trial_used_email_subject: v })} maxLength={150} placeholder={DEFAULT_FUNNEL_EMAIL_COPY.trial_used_email_subject} />
      </Field>
      <Field label="Trial already used email: message (un1t.online studios)">
        <Textarea value={block.trial_used_email_body || ''} onChange={(v) => onUpdate({ trial_used_email_body: v })} maxLength={2000} rows={6} placeholder={DEFAULT_FUNNEL_EMAIL_COPY.trial_used_email_body} />
      </Field>
      <Field label="Terms page could not load: message (un1t.online studios)">
        <Textarea value={block.legal_unavailable_message || ''} onChange={(v) => onUpdate({ legal_unavailable_message: v })} maxLength={300} rows={2} placeholder={D.legal_unavailable_message} />
      </Field>
    </>
  )
}

// PAIDTRIAL.1 — the paid trial product (/trial). Price in euros as a draft
// string, coerced to cents on write (same reasoning as ClassFunnelEdit). The
// Glofox product is REQUIRED: the page sells nothing until both ids are set.
// Exported for its test (PaidTrialEdit.test.jsx).
// CORPPROMO.1 — the words of a /corp promo. The studio, credits and expiry
// are fixed per promo in src/lib/corp-promos.js; tokens {credits},
// {expires_on}, {first_name} and {studio_name} are filled when shown.
const CORP_PROMO_TEXTS = [
  ['title', 'Title (top of the card)', 80, 1],
  ['eyebrow', 'Eyebrow', 60, 1],
  ['heading', 'Heading', 200, 1],
  ['subhead', 'Sub-copy', 400, 2],
  ['cta_label', 'Button label', 40, 1],
  ['consent_label', 'Consent checkbox text', 400, 3],
  ['done_title', 'Claimed — title', 120, 1],
  ['done_body', 'Claimed — message ({credits}, {expires_on})', 400, 2],
  ['already_claimed_text', 'Already claimed — message', 400, 3],
  ['trained_text', 'Trained here before — message', 400, 3],
  ['trial_used_text', 'Free trial already used — message', 400, 3],
  ['active_member_text', 'Already a member — message', 400, 3],
  ['help_text', 'Needs a check by the team — message', 400, 3],
  ['unavailable_text', 'Offer switched off — message', 200, 2],
  ['email_subject', 'Confirmation email — subject', 200, 1],
  ['email_body', 'Confirmation email — body ({first_name}, {credits}, {expires_on}, {studio_name})', 1200, 4],
]

// PAGES.1 — the paid_trial, campaign_funnel and corp_promo blocks no longer
// drive the campaign pages (/trial, /50plus, /corp): those are landing_pages
// rows now (mig 792), edited by the team until the Pages editor ships. Shown
// at the top of the three editors so an operator does not edit the wrong copy.
export function offerBlockNoticeText(block) {
  switch (block?.type) {
    case 'paid_trial':
      return 'This block drives the trial card on this studio page only. The /trial page is now its own page and, until the Pages editor ships, is edited by the team.'
    case 'campaign_funnel': {
      const where = block.campaign ? `/${block.campaign}` : 'its campaign page'
      return `This block no longer drives ${where}. That page is now its own page and, until the Pages editor ships, is edited by the team.`
    }
    case 'corp_promo':
      return 'This block no longer drives /corp. That page is now its own page and, until the Pages editor ships, is edited by the team.'
    default:
      return null
  }
}

export function OfferBlockNotice({ block }) {
  const text = offerBlockNoticeText(block)
  if (!text) return null
  return (
    <p role="note" className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700">{text}</p>
  )
}

// PAGES.1 — `pageOnly` (page mode): the page half only; the promo key is the
// studio row's (StudioOfferRow), and there is no legacy notice.
export function CorpPromoEdit({ block, onUpdate, pageOnly = false }) {
  const ticks = Array.isArray(block.ticks) ? block.ticks : []
  const setTick = (i, v) => {
    const next = [ticks[0] || '', ticks[1] || '', ticks[2] || '']
    next[i] = v
    onUpdate({ ticks: next })
  }
  return (
    <>
      {!pageOnly && <OfferBlockNotice block={block} />}
      {!pageOnly && (
      <Field label="Promo" hint="Blank applies these words to every /corp promo at this studio. The credits and their expiry are fixed per promo.">
        <Input value={block.promo_key || ''} onChange={(v) => onUpdate({ promo_key: v.trim() })} maxLength={60} placeholder="hatch-3-free" />
      </Field>
      )}
      {CORP_PROMO_TEXTS.slice(0, 4).map(([key, label, max, rows]) => (
        <Field key={key} label={label}>
          {rows > 1
            ? <Textarea value={block[key] || ''} onChange={(v) => onUpdate({ [key]: v })} maxLength={max} rows={rows} />
            : <Input value={block[key] || ''} onChange={(v) => onUpdate({ [key]: v })} maxLength={max} />}
        </Field>
      ))}
      <Field label="What's included" hint="Three ticks on the card. Blank lines are skipped.">
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <Input key={i} value={ticks[i] || ''} onChange={(v) => setTick(i, v)} maxLength={120} />)}
        </div>
      </Field>
      {CORP_PROMO_TEXTS.slice(4).map(([key, label, max, rows]) => (
        <Field key={key} label={label}>
          {rows > 1
            ? <Textarea value={block[key] || ''} onChange={(v) => onUpdate({ [key]: v })} maxLength={max} rows={rows} />
            : <Input value={block[key] || ''} onChange={(v) => onUpdate({ [key]: v })} maxLength={max} />}
        </Field>
      ))}
    </>
  )
}

// PAGES.1 — `pageOnly` (page mode): the page half only. The plan or product,
// price, length, product name and picker label are the studio rows'
// (StudioOfferRow); `membershipSource` then only says whether to show the
// un1t.online copy fields.
export function PaidTrialEdit({ block, onUpdate, locationId, membershipSource, pageOnly = false }) {
  const isUn1tOnline = membershipSource === 'un1t_online'
  const [priceDraft, setPriceDraft] = useState(centsToEuros(block.price_cents))
  useEffect(() => { setPriceDraft(centsToEuros(block.price_cents)) }, [block.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const [memberships, setMemberships] = useState([])
  const [membershipsLoading, setMembershipsLoading] = useState(false)
  useEffect(() => {
    if (!locationId || isUn1tOnline || pageOnly) return
    let alive = true
    setMembershipsLoading(true)
    fetch(`/api/locations/${locationId}/glofox-memberships`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (alive && j && j.success !== false) setMemberships(j.memberships || j.data || []) })
      .catch(() => {})
      .finally(() => { if (alive) setMembershipsLoading(false) })
    return () => { alive = false }
  }, [locationId, isUn1tOnline, pageOnly])
  // A un1t.online studio sells one of its mirrored paid products (the GET
  // answers `paid_products`; the text input stays until it arrives).
  const [paidProducts, setPaidProducts] = useState([])
  const [paidProductsLoading, setPaidProductsLoading] = useState(false)
  useEffect(() => {
    if (!locationId || !isUn1tOnline || pageOnly) return
    let alive = true
    setPaidProductsLoading(true)
    fetch(`/api/locations/${locationId}/un1t-online`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (alive && j && j.success !== false) setPaidProducts(Array.isArray(j.data?.paid_products) ? j.data.paid_products : []) })
      .catch(() => {})
      .finally(() => { if (alive) setPaidProductsLoading(false) })
    return () => { alive = false }
  }, [locationId, isUn1tOnline, pageOnly])
  const productId = block.un1t_product_id || ''
  const productKnown = paidProducts.some((p) => p.un1t_id === productId)
  const planKey = (block.membership_id && block.plan_code) ? `${block.membership_id}:${block.plan_code}` : ''
  const setPlan = (value) => {
    const [mid, pc] = value ? value.split(':') : ['', '']
    onUpdate({ membership_id: mid || '', plan_code: pc || '' })
  }
  const planOptions = buildTrialOptions(memberships, planKey)
  const ticks = Array.isArray(block.ticks) ? block.ticks : []
  const setTick = (i, v) => {
    const next = [ticks[0] || '', ticks[1] || '', ticks[2] || '']
    next[i] = v
    onUpdate({ ticks: next })
  }
  return (
    <>
      {!pageOnly && <OfferBlockNotice block={block} />}
      {!pageOnly && (
      <Field label="Studio label on /trial" hint="The name on this studio's choice card. Blank shows the studio's own name.">
        <Input value={block.studio_label || ''} onChange={(v) => onUpdate({ studio_label: v })} maxLength={60} />
      </Field>
      )}
      <Field label="Eyebrow" hint="Small line above the heading on the price panel.">
        <Input value={block.eyebrow || ''} onChange={(v) => onUpdate({ eyebrow: v })} maxLength={60} placeholder="14 day reset" />
      </Field>
      {/* A new block starts on Stillorgan's words (the factory does not know the studio). */}
      <p className="text-[11px] text-un1t-muted">Check the heading, button and paid messages name this studio&apos;s product.</p>
      <Field label="Heading">
        <Input value={block.heading || ''} onChange={(v) => onUpdate({ heading: v })} maxLength={200} placeholder="The 14 Day Reset" />
      </Field>
      <Field label="Short button label (sticky header)" hint="Used by the sticky header only, which adds its own arrow. e.g. “€39”. Blank uses the full button label.">
        <Input value={block.cta_label_short || ''} onChange={(v) => onUpdate({ cta_label_short: v })} maxLength={24} />
      </Field>
      <Field label="Sub-copy">
        <Textarea value={block.subhead || ''} onChange={(v) => onUpdate({ subhead: v })} maxLength={400} rows={2} />
      </Field>
      {!pageOnly && (
      <Field label="Product name" hint="On the checkout line, the receipt and the confirmation email.">
        <Input value={block.product_name || ''} onChange={(v) => onUpdate({ product_name: v })} maxLength={80} placeholder="The 14 Day Reset" />
      </Field>
      )}
      {!isUn1tOnline && !pageOnly && (
        <Field label="Price (€)" hint="What the buyer pays, taken by the studio's payment rail. Glofox never charges for this product.">
          <Input
            value={priceDraft}
            onChange={(v) => { setPriceDraft(v); const c = eurosToCents(v); if (c !== null) onUpdate({ price_cents: c }) }}
            maxLength={10}
            placeholder="39"
          />
        </Field>
      )}
      {!pageOnly && (
      <Field label="Trial length (days)">
        <Input value={String(block.duration_days ?? 14)} onChange={(v) => { const n = parseInt(v, 10); if (Number.isFinite(n)) onUpdate({ duration_days: n }) }} maxLength={3} placeholder="14" />
      </Field>
      )}
      <Field label="What's included" hint="Three ticks on the price panel. Blank lines are skipped.">
        <div className="space-y-2">
          <Input value={ticks[0] || ''} onChange={(v) => setTick(0, v)} maxLength={120} placeholder="Unlimited classes for 14 days" />
          <Input value={ticks[1] || ''} onChange={(v) => setTick(1, v)} maxLength={120} placeholder="Every session coach-led" />
          <Input value={ticks[2] || ''} onChange={(v) => setTick(2, v)} maxLength={120} placeholder="Book straight after you pay" />
        </div>
      </Field>
      <Field label="Button label">
        <Input value={block.cta_label || ''} onChange={(v) => onUpdate({ cta_label: v })} maxLength={40} placeholder="Start my 14 Day Reset" />
      </Field>
      <Field label="Consent checkbox text" hint="Beside the opt-in checkbox. Name the channels (email/SMS/WhatsApp).">
        <Textarea value={block.consent_label || ''} onChange={(v) => onUpdate({ consent_label: v })} maxLength={400} rows={3} />
      </Field>
      <Field label="Paid — title" hint="Shown once the plan is on their account.">
        <Input value={block.done_title || ''} onChange={(v) => onUpdate({ done_title: v })} maxLength={120} placeholder="You're in 🎉" />
      </Field>
      <Field label="Paid — message">
        <Textarea value={block.done_body || ''} onChange={(v) => onUpdate({ done_body: v })} maxLength={400} rows={2} />
      </Field>
      {isUn1tOnline && (
        <Field label="Being confirmed — message" hint="Shown after un1t.online's checkout until the purchase is confirmed (up to about 15 minutes).">
          <Textarea value={block.pending_body || ''} onChange={(v) => onUpdate({ pending_body: v })} maxLength={400} rows={2} />
        </Field>
      )}
      {!isUn1tOnline && !pageOnly && (
        <Field
          label="Glofox product granted after payment"
          hint="REQUIRED. A €0 plan in Glofox for this trial (the money is taken here, not by Glofox). Until both ids are set the page sells nothing."
        >
          {planOptions.length > 0 ? (
            <select
              value={planKey}
              onChange={(e) => setPlan(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            >
              <option value="">— Not set (page sells nothing) —</option>
              {planOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
            <Input
              value={planKey}
              onChange={(v) => setPlan(v)}
              maxLength={120}
              placeholder={membershipsLoading ? 'Loading Glofox products…' : 'membershipId:planCode'}
            />
          )}
        </Field>
      )}
      {isUn1tOnline && !pageOnly && (
        <Field
          label="un1t.online product"
          hint="The product in un1t.online. The price shown on /trial is the product's live price."
        >
          {paidProducts.length > 0 ? (
            <select
              value={productId}
              onChange={(e) => onUpdate({ un1t_product_id: e.target.value })}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            >
              <option value="">— Not set (page sells nothing) —</option>
              {productId && !productKnown && <option value={productId}>{productId}</option>}
              {paidProducts.map((p) => (
                <option key={p.un1t_id} value={p.un1t_id}>{`${p.title} · €${centsToEuros(p.price_cents)}`}</option>
              ))}
            </select>
          ) : (
            <Input
              value={productId}
              onChange={(v) => onUpdate({ un1t_product_id: v.trim() })}
              maxLength={64}
              placeholder={paidProductsLoading ? 'Loading un1t.online products…' : 'un1t.online product id'}
            />
          )}
        </Field>
      )}
      <Field label="Already had a trial — message" hint="Shown when the buyer's email has had a trial at this studio.">
        <Textarea value={block.trial_used_text || ''} onChange={(v) => onUpdate({ trial_used_text: v })} maxLength={500} rows={3} />
      </Field>
      <Field label="Already a member — message" hint="Shown when the buyer is already an active member.">
        <Textarea value={block.active_member_text || ''} onChange={(v) => onUpdate({ active_member_text: v })} maxLength={500} rows={3} />
      </Field>
      <Field label="Help button label">
        <Input value={block.help_cta_label || ''} onChange={(v) => onUpdate({ help_cta_label: v })} maxLength={40} placeholder="I need help" />
      </Field>
      <Field label="Help sent — message" hint="Shown after the buyer taps the help button.">
        <Textarea value={block.help_sent_text || ''} onChange={(v) => onUpdate({ help_sent_text: v })} maxLength={400} rows={2} />
      </Field>
      <Field label="Scroll cue label" hint="Shown with an arrow at the bottom of the /trial hero, pointing down to the studio sections.">
        <Input value={block.scroll_cue_label || ''} onChange={(v) => onUpdate({ scroll_cue_label: v })} maxLength={40} placeholder="Learn more about the studio" />
      </Field>
      {isUn1tOnline && (
        <>
          <Field
            label="New account email — subject"
            hint="Sent once the purchase is confirmed to a buyer whose un1t.online account we made, before un1t.online's set-password code. Blank uses the default."
          >
            <Input
              value={block.account_email_subject || ''}
              onChange={(v) => onUpdate({ account_email_subject: v })}
              maxLength={200}
              placeholder={PAID_TRIAL_ACCOUNT_EMAIL_DEFAULT.account_email_subject}
            />
          </Field>
          <Field label="New account email — message" hint="Placeholders: {first_name}, {product_name}, {studio_name}.">
            <Textarea
              value={block.account_email_body || ''}
              onChange={(v) => onUpdate({ account_email_body: v })}
              maxLength={1000}
              rows={4}
            />
          </Field>
        </>
      )}
    </>
  )
}

// PAGES.1 — `pageOnly` (page mode): the page half only. The trial plan, price,
// consult and typed timetable are the studio rows' (StudioOfferRow).
export function ClassFunnelEdit({ block, onUpdate, availableBookingTypes, locationId, publicPath, pageOnly = false }) {
  const bts = availableBookingTypes || []
  // Price is edited as a raw euros string (draft) and only coerced to integer
  // cents on write — a fully-controlled input re-derived from cents each
  // keystroke would eat the decimal point ("29.50" → 29 → 2950 cents wrong).
  // Resync only when the edited block changes identity.
  const [priceDraft, setPriceDraft] = useState(centsToEuros(block.price_cents))
  useEffect(() => { setPriceDraft(centsToEuros(block.price_cents)) }, [block.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const [memberships, setMemberships] = useState([])
  const [membershipsLoading, setMembershipsLoading] = useState(false)
  useEffect(() => {
    if (!locationId || pageOnly) return
    let alive = true
    setMembershipsLoading(true)
    fetch(`/api/locations/${locationId}/glofox-memberships`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (alive && j && j.success !== false) setMemberships(j.memberships || j.data || []) })
      .catch(() => {})
      .finally(() => { if (alive) setMembershipsLoading(false) })
    return () => { alive = false }
  }, [locationId, pageOnly])
  const trialKey = (block.trial_membership_id && block.trial_plan_code)
    ? `${block.trial_membership_id}:${block.trial_plan_code}` : ''
  const setTrial = (value) => {
    const [mid, pc] = value ? value.split(':') : ['', '']
    onUpdate({ trial_membership_id: mid || '', trial_plan_code: pc || '' })
  }
  const trialOptions = buildTrialOptions(memberships, trialKey)
  return (
    <>
      <Field label="Heading">
        <Input value={block.heading || ''} onChange={(v) => onUpdate({ heading: v })} maxLength={200} placeholder="Your first 3 classes are free" />
      </Field>
      <Field label="Sub-copy" hint="Line under the heading on the details step.">
        <Textarea value={block.subhead || ''} onChange={(v) => onUpdate({ subhead: v })} maxLength={400} rows={2} />
      </Field>
      <Field label="Consent checkbox text" hint="Beside the opt-in checkbox. Keep it explicit for GDPR — name the channels (email/SMS/WhatsApp).">
        <Textarea value={block.consent_label || ''} onChange={(v) => onUpdate({ consent_label: v })} maxLength={400} rows={3} />
      </Field>
      <Field label="Class booked — title">
        <Input value={block.class_done_title || ''} onChange={(v) => onUpdate({ class_done_title: v })} maxLength={120} placeholder="You're being booked in 🎉" />
      </Field>
      <Field label="Class booked — message">
        <Textarea value={block.class_done_body || ''} onChange={(v) => onUpdate({ class_done_body: v })} maxLength={400} rows={2} />
      </Field>
      {/* REGISTRYREAD.1a — shown when the timetable could not be read at the
          moment someone books (the booking is not taken; their details stay
          in the form). Blank keeps the default. */}
      <Field label="Timetable unavailable — message" hint="Shown if we can't check the timetable when someone books. Leave blank for the default.">
        <Textarea value={block.timetable_unavailable_message || ''} onChange={(v) => onUpdate({ timetable_unavailable_message: v })} maxLength={300} rows={2} placeholder={DEFAULT_TIMETABLE_UNAVAILABLE_MESSAGE} />
      </Field>
      <Field label="Button label" hint="On the buttons that scroll to this funnel (page header, sections, footer). Leave blank for the default.">
        <Input value={block.cta_label || ''} onChange={(v) => onUpdate({ cta_label: v })} maxLength={40} placeholder={DEFAULT_CLASS_FUNNEL_CTA_LABEL} />
      </Field>
      <Un1tFunnelCopyFields block={block} onUpdate={onUpdate} />
      <ManualTimetableFields block={block} onUpdate={onUpdate} publicPath={publicPath} pageOnly={pageOnly} />
      {!pageOnly && (<>
      <Field
        label="Trial product granted on booking"
        hint="Which Glofox membership/plan a NEW member gets on booking. Leave on the location default unless this funnel should grant a different intro offer."
      >
        {trialOptions.length > 0 ? (
          <select
            value={trialKey}
            onChange={(e) => setTrial(e.target.value)}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
          >
            <option value="">— Use location default —</option>
            {trialOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        ) : (
          <Input
            value={trialKey}
            onChange={(v) => setTrial(v)}
            maxLength={120}
            placeholder={membershipsLoading ? 'Loading Glofox products…' : 'membershipId:planCode (optional)'}
          />
        )}
        {membershipsLoading && trialOptions.length > 0 && (
          <p className="text-[11px] text-un1t-muted mt-1">Loading membership list…</p>
        )}
      </Field>
      <Field
        label="Price (€)"
        hint="Leave blank for a FREE trial (today's behaviour). If set, the funnel charges this for the chosen trial product — the location's payment rail must be configured."
      >
        <Input
          value={priceDraft}
          onChange={(v) => { setPriceDraft(v); onUpdate({ price_cents: eurosToCents(v) }) }}
          maxLength={10}
          placeholder="e.g. 29"
        />
      </Field>
      <Field
        label="Free-consult upsell"
        hint={bts.length === 0
          ? 'No active booking types here — leave empty for no upsell. Create one under Bookings → Booking types.'
          : 'Optional. Pick the booking type offered after a class is booked. Leave empty for no upsell.'}
      >
        {bts.length > 0 ? (
          <select
            value={block.consult_slug || ''}
            onChange={(e) => onUpdate({ consult_slug: e.target.value })}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
          >
            <option value="">— No consult upsell —</option>
            {bts.map((bt) => (
              <option key={bt.id} value={bt.slug}>{bt.name} ({bt.slug})</option>
            ))}
            {block.consult_slug && !bts.some((bt) => bt.slug === block.consult_slug) && (
              <option value={block.consult_slug}>{block.consult_slug} (no longer active)</option>
            )}
          </select>
        ) : (
          <Input value={block.consult_slug || ''} onChange={(v) => onUpdate({ consult_slug: v })} maxLength={200} placeholder="free-un1t-consultation" />
        )}
      </Field>
      </>)}
      {(block.consult_slug || pageOnly) && (
        <>
          <Field label="Consult booked — title">
            <Input value={block.consult_done_title || ''} onChange={(v) => onUpdate({ consult_done_title: v })} maxLength={120} placeholder="You're booked 🎉" />
          </Field>
          <Field label="Consult booked — message">
            <Textarea value={block.consult_done_body || ''} onChange={(v) => onUpdate({ consult_done_body: v })} maxLength={400} rows={2} />
          </Field>
        </>
      )}
    </>
  )
}

// FIFTYPLUS.1 — the campaign_funnel block editor (its page: /<campaign>).
// The trial plan is REQUIRED: the page takes no booking until both ids are
// set, and never falls back to the studio's default trial (the generic one).
// Exported for its test (CampaignFunnelEdit.test.jsx).
const SECTION_LABELS = { stats: 'Numbers (stats)', video_testimonials: 'Member videos', reviews: 'Google reviews' }
// PAGES.1 — `pageOnly` (page mode): the page half only. No campaign key (the
// page's slug replaces it), no section ticks (the page's own blocks are its
// sections), and the trial plan, keywords and tracking are the studio rows'.
export function CampaignFunnelEdit({ block, onUpdate, locationId, uploadMedia, uploading, uploadErr, progress, pageOnly = false }) {
  const k = (suffix) => `${block.id}-${suffix}`
  const [memberships, setMemberships] = useState([])
  useEffect(() => {
    if (!locationId || pageOnly) return
    let alive = true
    fetch(`/api/locations/${locationId}/glofox-memberships`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (alive && j && j.success !== false) setMemberships(j.memberships || j.data || []) })
      .catch(() => {})
    return () => { alive = false }
  }, [locationId, pageOnly])
  const planKey = (block.trial_membership_id && block.trial_plan_code) ? `${block.trial_membership_id}:${block.trial_plan_code}` : ''
  const setPlan = (value) => {
    const [mid, pc] = value ? value.split(':') : ['', '']
    onUpdate({ trial_membership_id: mid || '', trial_plan_code: pc || '' })
  }
  const planOptions = buildTrialOptions(memberships, planKey)
  const cards = Array.isArray(block.expect_cards) ? block.expect_cards : []
  const setCard = (i, patch) => {
    const next = [0, 1, 2].map((j) => ({ title: '', body: '', ...(cards[j] || {}) }))
    next[i] = { ...next[i], ...patch }
    onUpdate({ expect_cards: next })
  }
  const sections = Array.isArray(block.show_sections) ? block.show_sections : [...CAMPAIGN_FUNNEL_SECTIONS]
  const toggleSection = (name) => {
    const next = sections.includes(name)
      ? sections.filter((s) => s !== name)
      : CAMPAIGN_FUNNEL_SECTIONS.filter((s) => s === name || sections.includes(s))
    onUpdate({ show_sections: next })
  }
  const D = CAMPAIGN_FUNNEL_COPY_DEFAULTS
  // The video's poster: captured from the clip when none was uploaded.
  const onUploadVideo = async (file) => {
    let poster_url = block.poster_url || ''
    if (!poster_url) {
      try {
        const posterFile = await captureVideoPoster(file)
        poster_url = (await uploadMedia({ file: posterFile, kind: 'image', key: k('poster') })) || ''
      } catch { /* a clip the browser cannot decode: no poster */ }
    }
    const video_url = await uploadMedia({ file, kind: 'video', key: k('video'), autoplay: true })
    if (video_url) onUpdate({ video_url, poster_url: poster_url || null })
  }
  const selectCls = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text'
  return (
    <>
      {!pageOnly && (<>
      <OfferBlockNotice block={block} />
      <Field label="Page" hint="The page this block drives. Fixed per campaign.">
        <input value={block.campaign || ''} readOnly aria-label="Campaign key" className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-muted" />
      </Field>
      <Field label="Glofox trial plan" hint="REQUIRED. The plan put on a new person's account before their booking. Until it is set the page takes no bookings, and it never falls back to the studio's default trial.">
        <select aria-label="Glofox trial plan" value={planKey} onChange={(e) => setPlan(e.target.value)} className={selectCls}>
          <option value="">— Not set (page takes no bookings) —</option>
          {planOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      <Field label="Classes offered (keywords)" hint="One per line. A class is offered only when its name contains any of them (case does not matter). Empty offers nothing.">
        <Textarea value={block.class_keywords || ''} onChange={(v) => onUpdate({ class_keywords: v })} maxLength={400} rows={2} placeholder="50+" />
      </Field>
      </>)}
      <Field label="Coach video" hint="MP4 / WebM, up to 50MB. Starts muted on loop with a Tap for sound button, so burn the captions in. Tip: 720p, 20 to 40 seconds.">
        <MediaSlot
          url={block.video_url || ''}
          onClear={() => onUpdate({ video_url: null })}
          onUpload={onUploadVideo}
          uploading={!!uploading[k('video')] || !!uploading[k('poster')]}
          error={uploadErr[k('video')] || uploadErr[k('poster')]}
          accept="video/mp4,video/webm"
          label="Add video"
          kind="video"
          progress={progress[k('video')]}
        />
      </Field>
      <Field label="Poster image" hint="The still before the video plays. Captured from the clip when you upload one; replace it here.">
        <MediaSlot
          url={block.poster_url || ''}
          onClear={() => onUpdate({ poster_url: null })}
          onUpload={async (file) => { const url = await uploadMedia({ file, kind: 'image', key: k('poster') }); if (url) onUpdate({ poster_url: url }) }}
          uploading={!!uploading[k('poster')]}
          error={uploadErr[k('poster')]}
          accept="image/png,image/jpeg,image/webp"
          label="Add image"
          kind="image"
        />
      </Field>
      <Field label="Eyebrow"><Input value={block.eyebrow || ''} onChange={(v) => onUpdate({ eyebrow: v })} maxLength={80} placeholder={D.eyebrow} /></Field>
      <Field label="Heading"><Input value={block.heading || ''} onChange={(v) => onUpdate({ heading: v })} maxLength={200} placeholder={D.heading} /></Field>
      <Field label="Sub-copy"><Textarea value={block.subhead || ''} onChange={(v) => onUpdate({ subhead: v })} maxLength={400} rows={2} placeholder={D.subhead} /></Field>
      <Field label="Sound button label"><Input value={block.sound_label || ''} onChange={(v) => onUpdate({ sound_label: v })} maxLength={40} placeholder={D.sound_label} /></Field>
      <Field label="Pick step — title"><Input value={block.pick_title || ''} onChange={(v) => onUpdate({ pick_title: v })} maxLength={120} placeholder={D.pick_title} /></Field>
      <Field label="Pick step — message"><Input value={block.pick_body || ''} onChange={(v) => onUpdate({ pick_body: v })} maxLength={200} placeholder={D.pick_body} /></Field>
      <Field label="Button label" hint="{day} is the weekday, {time} the class time."><Input value={block.cta_label || ''} onChange={(v) => onUpdate({ cta_label: v })} maxLength={60} placeholder={D.cta_label} /></Field>
      <Field label="Reassurance line" hint="Under the button."><Input value={block.reassurance || ''} onChange={(v) => onUpdate({ reassurance: v })} maxLength={120} placeholder={D.reassurance} /></Field>
      <Field label="Details step — title"><Input value={block.details_title || ''} onChange={(v) => onUpdate({ details_title: v })} maxLength={120} placeholder={D.details_title} /></Field>
      <Field label="Details step — message"><Input value={block.details_body || ''} onChange={(v) => onUpdate({ details_body: v })} maxLength={200} placeholder={D.details_body} /></Field>
      <Field label="Consent checkbox text"><Textarea value={block.consent_label || ''} onChange={(v) => onUpdate({ consent_label: v })} maxLength={400} rows={2} /></Field>
      <Field label="Booked — title"><Input value={block.done_title || ''} onChange={(v) => onUpdate({ done_title: v })} maxLength={120} placeholder={D.done_title} /></Field>
      <Field label="Booked — message"><Textarea value={block.done_body || ''} onChange={(v) => onUpdate({ done_body: v })} maxLength={400} rows={2} placeholder={D.done_body} /></Field>
      <Field label="No classes — message" hint="Shown when no class is open to book in the next two weeks."><Textarea value={block.no_classes_text || ''} onChange={(v) => onUpdate({ no_classes_text: v })} maxLength={400} rows={2} placeholder={D.no_classes_text} /></Field>
      <Field label="Not configured — message" hint={pageOnly ? 'Shown at a studio with no trial plan set on its row.' : 'Shown while no trial plan is set above.'}><Textarea value={block.not_configured_text || ''} onChange={(v) => onUpdate({ not_configured_text: v })} maxLength={400} rows={2} placeholder={D.not_configured_text} /></Field>
      <Field label="Timetable unavailable — message"><Textarea value={block.timetable_unavailable_text || ''} onChange={(v) => onUpdate({ timetable_unavailable_text: v })} maxLength={400} rows={2} placeholder={D.timetable_unavailable_text} /></Field>
      <Field label="What to expect — eyebrow"><Input value={block.expect_eyebrow || ''} onChange={(v) => onUpdate({ expect_eyebrow: v })} maxLength={80} placeholder={D.expect_eyebrow} /></Field>
      <Field label="What to expect — heading"><Input value={block.expect_heading || ''} onChange={(v) => onUpdate({ expect_heading: v })} maxLength={200} placeholder={D.expect_heading} /></Field>
      <Field label="What to expect — three cards">
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-2">
              <Input value={cards[i]?.title || ''} onChange={(v) => setCard(i, { title: v })} maxLength={80} placeholder={`Card ${i + 1} title`} />
              <Input value={cards[i]?.body || ''} onChange={(v) => setCard(i, { body: v })} maxLength={240} placeholder={`Card ${i + 1} text`} />
            </div>
          ))}
        </div>
      </Field>
      {!pageOnly && (<>
      <Field label="Sections under the hero" hint="This page's own sections, shown in the light look.">
        <div className="space-y-1.5">
          {CAMPAIGN_FUNNEL_SECTIONS.map((name) => (
            <label key={name} className="flex items-center gap-2 text-sm text-un1t-text">
              <input type="checkbox" checked={sections.includes(name)} onChange={() => toggleSection(name)} className="w-4 h-4" />
              {SECTION_LABELS[name]}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Tracking (advanced)" hint="Blank uses the defaults shown. The tag goes on every lead; the lead source and the Meta page URL are what the reports and the server Lead carry.">
        <div className="space-y-2">
          <Input value={block.tag || ''} onChange={(v) => onUpdate({ tag: v })} maxLength={80} placeholder={`stillorgan-${block.campaign || ''}`} />
          <Input value={block.lead_source || ''} onChange={(v) => onUpdate({ lead_source: v })} maxLength={80} placeholder={`meta_${block.campaign || ''}`} />
          <Input value={block.event_source_url || ''} onChange={(v) => onUpdate({ event_source_url: v })} maxLength={300} placeholder={`https://www.un1tdublin.com/${block.campaign || ''}`} />
        </div>
      </Field>
      </>)}
    </>
  )
}

function PillarsEdit({ block, onUpdate, uploadMedia, uploading, uploadErr }) {
  const items = Array.isArray(block.items) ? block.items : []
  const setItem = (i, patch) => onUpdate({ items: items.map((x, j) => j === i ? { ...x, ...patch } : x) })
  const addItem = () => onUpdate({ items: [...items, { number: '', title: '', body: '', photo_url: null }] })
  const removeItem = (i) => onUpdate({ items: items.filter((_, j) => j !== i) })
  const move = (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[i], next[j]] = [next[j], next[i]]
    onUpdate({ items: next })
  }
  return (
    <>
      {items.slice(0, 6).map((p, i) => {
        const k = (suffix) => `${block.id}-pillar-${i}-${suffix}`
        return (
          <div key={i} className="border border-un1t-border rounded-md p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wider text-un1t-muted">Pillar {i + 1}</div>
              <div className="flex items-center gap-1">
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="p-1 text-un1t-muted hover:text-un1t-text disabled:opacity-30" title="Move up"><ArrowUp size={11} /></button>
                <button type="button" disabled={i === items.length - 1} onClick={() => move(i, 1)} className="p-1 text-un1t-muted hover:text-un1t-text disabled:opacity-30" title="Move down"><ArrowDown size={11} /></button>
                <button type="button" onClick={() => removeItem(i)} className="p-1 text-un1t-muted hover:text-red-400" title="Remove pillar"><Trash2 size={11} /></button>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-[80px_1fr] gap-3 items-start">
              <Input value={p.number || ''} onChange={(v) => setItem(i, { number: v })} maxLength={20} placeholder={`0${i + 1}`} />
              <div className="space-y-2">
                <Input value={p.title || ''} onChange={(v) => setItem(i, { title: v })} maxLength={200} placeholder="Title" />
                <Textarea value={p.body || ''} onChange={(v) => setItem(i, { body: v })} maxLength={1000} rows={2} placeholder="Description" />
              </div>
            </div>
            <div>
              <p className="text-[11px] text-un1t-muted mb-2">Optional photo above this pillar</p>
              <MediaSlot
                url={p.photo_url || ''}
                onClear={() => setItem(i, { photo_url: null })}
                onUpload={async (file) => { const url = await uploadMedia({ file, kind: 'image', key: k('photo') }); if (url) setItem(i, { photo_url: url }) }}
                uploading={!!uploading[k('photo')]}
                error={uploadErr[k('photo')]}
                accept="image/png,image/jpeg,image/webp"
                label="Add photo"
                kind="image"
              />
            </div>
          </div>
        )
      })}
      {items.length < 6 && (
        <button type="button" onClick={addItem} className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1.5">
          <Plus size={12} /> Add pillar
        </button>
      )}
    </>
  )
}

function VideoTestimonialsEdit({ block, onUpdate, uploadMedia, uploading, uploadErr, progress }) {
  const items = Array.isArray(block.items) ? block.items : []
  const setItem = (i, patch) => onUpdate({ items: items.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
  const addItem = () => onUpdate({ items: [...items, { video_url: '', poster_url: '', name: '' }] })
  const removeItem = (i) => onUpdate({ items: items.filter((_, j) => j !== i) })
  const move = (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[i], next[j]] = [next[j], next[i]]
    onUpdate({ items: next })
  }

  // On clip upload: capture the poster from the LOCAL file first (no
  // CORS), upload it via the image path, then upload the video. Store
  // both URLs on the item. A failed poster capture is non-fatal — the
  // clip still saves and the tile falls back to a placeholder.
  const onUploadClip = async (i, file, posterKey, videoKey) => {
    const posterFile = await captureVideoPoster(file)
    let poster_url = ''
    if (posterFile) {
      poster_url = (await uploadMedia({ file: posterFile, kind: 'image', key: posterKey })) || ''
    }
    // Testimonial clips are tap-to-play (poster shown until tapped), so a larger
    // stored file is fine — only the visitor who taps one downloads it.
    const video_url = await uploadMedia({ file, kind: 'video', key: videoKey, autoplay: false })
    if (video_url) setItem(i, { video_url, poster_url })
  }

  return (
    <>
      <Field label="Section heading">
        <Input value={block.title || ''} onChange={(v) => onUpdate({ title: v })} maxLength={200} placeholder="Hear from our members" />
      </Field>
      {items.slice(0, 3).map((it, i) => {
        const posterKey = `${block.id}-vt-${i}-poster`
        const videoKey = `${block.id}-vt-${i}-video`
        return (
          <div key={i} className="border border-un1t-border rounded-md p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wider text-un1t-muted">Video {i + 1}</div>
              <div className="flex items-center gap-1">
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="p-1 text-un1t-muted hover:text-un1t-text disabled:opacity-30" title="Move up"><ArrowUp size={11} /></button>
                <button type="button" disabled={i === items.length - 1} onClick={() => move(i, 1)} className="p-1 text-un1t-muted hover:text-un1t-text disabled:opacity-30" title="Move down"><ArrowDown size={11} /></button>
                <button type="button" onClick={() => removeItem(i)} className="p-1 text-un1t-muted hover:text-red-400" title="Remove video"><Trash2 size={11} /></button>
              </div>
            </div>
            <MediaSlot
              url={it.video_url || ''}
              onClear={() => setItem(i, { video_url: '', poster_url: '' })}
              onUpload={(file) => onUploadClip(i, file, posterKey, videoKey)}
              uploading={!!uploading[videoKey] || !!uploading[posterKey]}
              error={uploadErr[videoKey] || uploadErr[posterKey]}
              accept="video/mp4,video/webm"
              label="Add video"
              kind="video"
              progress={progress[videoKey]}
            />
            <Input value={it.name || ''} onChange={(v) => setItem(i, { name: v })} maxLength={120} placeholder="Member name (e.g. Sarah)" />
          </div>
        )
      })}
      {items.length < 3 && (
        <button type="button" onClick={addItem} className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1.5">
          <Plus size={12} /> Add video
        </button>
      )}
      <p className="text-[11px] text-un1t-muted">MP4 / WebM / MOV, up to 200MB each — large clips are compressed automatically where your browser supports it. Portrait clips work best. We grab the first frame as the still image automatically. Tip: 720p, 15–30 seconds.</p>
    </>
  )
}

function GalleryEdit({ block, onUpdate, uploadMedia, uploading, uploadErr }) {
  const items = Array.isArray(block.items) ? block.items : []
  const setItem = (i, patch) => onUpdate({ items: items.map((x, j) => j === i ? { ...x, ...patch } : x) })
  const removeItem = (i) => onUpdate({ items: items.filter((_, j) => j !== i) })
  const move = (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[i], next[j]] = [next[j], next[i]]
    onUpdate({ items: next })
  }
  const addPhoto = async (file) => {
    const url = await uploadMedia({ file, kind: 'image', key: `${block.id}-gallery` })
    if (url) onUpdate({ items: [...items, { url, alt: '', caption: '' }] })
  }
  const k = `${block.id}-gallery`
  return (
    <>
      <Field label="Section heading">
        <Input value={block.title || ''} onChange={(v) => onUpdate({ title: v })} maxLength={200} placeholder="Inside the studio" />
      </Field>
      <Field label={`Photos (${items.length}/24)`} hint="PNG/JPEG/WebP — auto-optimized on upload.">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {items.map((g, i) => (
            <div key={i} className="relative group border border-un1t-border rounded-md overflow-hidden bg-un1t-bg">
              { }
              <img src={g.url} alt={g.alt || ''} className="w-full aspect-square object-cover" />
              <div className="p-2 space-y-1">
                <input
                  type="text"
                  value={g.caption || ''}
                  onChange={(e) => setItem(i, { caption: e.target.value })}
                  placeholder="Caption (optional)"
                  maxLength={400}
                  className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
                />
                <input
                  type="text"
                  value={g.alt || ''}
                  onChange={(e) => setItem(i, { alt: e.target.value })}
                  placeholder="Alt text (a11y)"
                  maxLength={400}
                  className="w-full bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text"
                />
              </div>
              <div className="absolute top-1 right-1 flex gap-1">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Move left" className="p-1 bg-black/70 text-white rounded hover:bg-black disabled:opacity-30"><ArrowUp size={11} /></button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === items.length - 1} title="Move right" className="p-1 bg-black/70 text-white rounded hover:bg-black disabled:opacity-30"><ArrowDown size={11} /></button>
                <button type="button" onClick={() => removeItem(i)} title="Remove photo" className="p-1 bg-black/70 text-red-300 rounded hover:bg-red-700 hover:text-white"><Trash2 size={11} /></button>
              </div>
            </div>
          ))}
          {items.length < 24 && (
            <label className={`bg-un1t-bg border-2 border-dashed border-un1t-border hover:border-un1t-muted rounded-md aspect-square flex flex-col items-center justify-center text-un1t-subtle cursor-pointer ${uploading[k] ? 'opacity-50 pointer-events-none' : ''}`}>
              {uploading[k] ? <Loader2 size={20} className="animate-spin" /> : <ImagePlus size={20} />}
              <span className="text-[10px] mt-2">{uploading[k] ? 'Uploading…' : 'Add photo'}</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) addPhoto(f); e.target.value = '' }}
              />
            </label>
          )}
        </div>
        {uploadErr[k] && <p className="text-[11px] text-red-700 mt-2">{uploadErr[k]}</p>}
      </Field>
    </>
  )
}

function EmbedEdit({ block, onUpdate }) {
  return (
    <>
      <Field label="Section heading">
        <Input value={block.title || ''} onChange={(v) => onUpdate({ title: v })} maxLength={200} placeholder="See it in motion" />
      </Field>
      <Field label="YouTube or Instagram URL" hint="Examples: https://youtu.be/abc123, https://www.instagram.com/reel/xyz/">
        <Input value={block.url || ''} onChange={(v) => onUpdate({ url: v })} maxLength={2000} placeholder="https://" />
      </Field>
      <Field label="Caption (optional)" hint="Small text under the embed.">
        <Input value={block.caption || ''} onChange={(v) => onUpdate({ caption: v })} maxLength={400} />
      </Field>
    </>
  )
}

function StatsEdit({ block, onUpdate }) {
  const items = Array.isArray(block.items) ? block.items : []
  const setItem = (i, patch) => onUpdate({ items: items.map((x, j) => j === i ? { ...x, ...patch } : x) })
  const addItem = () => onUpdate({ items: [...items, { number: '', label: '' }] })
  const removeItem = (i) => onUpdate({ items: items.filter((_, j) => j !== i) })
  const move = (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[i], next[j]] = [next[j], next[i]]
    onUpdate({ items: next })
  }
  return (
    <>
      {items.slice(0, 6).map((s, i) => (
        <div key={i} className="grid grid-cols-[120px_1fr_auto] gap-3 items-center">
          <Input value={s.number || ''} onChange={(v) => setItem(i, { number: v })} maxLength={20} placeholder="200+" />
          <Input value={s.label || ''} onChange={(v) => setItem(i, { label: v })} maxLength={200} placeholder="Label" />
          <div className="flex items-center gap-1">
            <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="p-1 text-un1t-muted hover:text-un1t-text disabled:opacity-30" title="Move up"><ArrowUp size={11} /></button>
            <button type="button" disabled={i === items.length - 1} onClick={() => move(i, 1)} className="p-1 text-un1t-muted hover:text-un1t-text disabled:opacity-30" title="Move down"><ArrowDown size={11} /></button>
            <button type="button" onClick={() => removeItem(i)} className="p-1 text-un1t-muted hover:text-red-400" title="Remove stat"><Trash2 size={11} /></button>
          </div>
        </div>
      ))}
      {items.length < 6 && (
        <button type="button" onClick={addItem} className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1.5">
          <Plus size={12} /> Add stat
        </button>
      )}
    </>
  )
}

function TestimonialEdit({ block, onUpdate }) {
  return (
    <>
      <Field label="Quote">
        <Textarea value={block.quote || ''} onChange={(v) => onUpdate({ quote: v })} maxLength={2000} rows={3} placeholder="Member quote" />
      </Field>
      <Field label="Author" hint='How the quote is attributed.'>
        <Input value={block.author || ''} onChange={(v) => onUpdate({ author: v })} maxLength={200} placeholder="Member, joined 2024" />
      </Field>
    </>
  )
}

function ReviewsEdit({ block, onUpdate }) {
  return (
    <>
      <Field label="Heading">
        <Input value={block.title || ''} onChange={(v) => onUpdate({ title: v })} maxLength={200} placeholder="What our members say" />
      </Field>
      <Field label="Minimum star rating to show">
        <select
          value={block.min_rating ?? 4}
          onChange={(e) => onUpdate({ min_rating: Number(e.target.value) })}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
        >
          {[5, 4, 3, 2, 1].map((n) => (
            <option key={n} value={n}>{n}★ and up</option>
          ))}
        </select>
      </Field>
      <Field label="Marquee speed">
        <select
          value={block.speed || 'normal'}
          onChange={(e) => onUpdate({ speed: e.target.value })}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
        >
          <option value="slow">Slow</option>
          <option value="normal">Normal</option>
          <option value="fast">Fast</option>
        </select>
      </Field>
      <p className="text-[11px] text-un1t-muted">
        Reviews are curated per location — the marquee shows the stored Google
        reviews that match the minimum rating above.
      </p>
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Helpers — input primitives + uniform media-upload tile
// ─────────────────────────────────────────────────────────────

function MediaSlot({ url, onClear, onUpload, uploading, error, accept, label, kind, progress }) {
  return (
    <div className="flex flex-col gap-1">
      {url ? (
        <div className="relative inline-block">
          {kind === 'video' ? (
            <video src={url} className="w-40 h-24 object-cover rounded-md border border-un1t-border bg-black" muted playsInline autoPlay loop />
          ) : (
             
            <img src={url} alt="Preview" className="w-40 h-24 object-cover rounded-md border border-un1t-border" />
          )}
          <button
            type="button"
            onClick={onClear}
            className="absolute -top-2 -right-2 bg-un1t-surface border border-un1t-border rounded-full p-1 text-un1t-subtle hover:text-red-500"
            title="Clear"
          >
            <XIcon size={11} />
          </button>
        </div>
      ) : (
        <label className={`bg-un1t-bg border-2 border-dashed border-un1t-border hover:border-un1t-muted rounded-md w-40 h-24 flex flex-col items-center justify-center text-un1t-subtle cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
          {uploading
            ? <Loader2 size={18} className="animate-spin" />
            : (kind === 'video' ? <Video size={18} /> : <ImagePlus size={18} />)}
          <span className="text-[10px] mt-1 text-center px-1">
            {progress?.phase === 'compress'
              ? `Compressing… ${Math.round(progress.percent || 0)}%`
              : progress?.phase === 'upload'
                ? 'Uploading…'
                : uploading ? 'Uploading…' : label}
          </span>
          <input
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = '' }}
          />
        </label>
      )}
      {error && <p className="text-[11px] text-red-700">{error}</p>}
    </div>
  )
}

// W1.S1b — the embed snippet is HTML an operator pastes elsewhere; the brand
// is operator text, so it is attribute-escaped.
function escapeAttr(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
