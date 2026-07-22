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
  BLOCK_TYPES, blocksOrDefault, newBlockOfType, setByPath, newBlockId,
} from '@/lib/landing-page-blocks'

// PostMessage namespace shared with src/components/landing-page/
// EditModeOverlay.jsx so the iframe and the parent only react to
// each other and ignore the noise from extensions / dev tools.
const MESSAGE_NAMESPACE = 'lp-editor'

export default function LandingPageSettingsForm({ locationId, initialSettings, availableBookingTypes, publicPath = null, availableEvents = [] }) {
  // LP multi-page: the preview iframe + "View live" links point at the
  // SELECTED studio's public page when known (public_path from mig 227),
  // falling back to the generic /welcome for a single-studio install.
  const previewSrc = publicPath ? `/welcome/${publicPath}?edit=1` : '/welcome?edit=1'
  const liveUrl = publicPath ? `/${publicPath}` : '/welcome'
  // Seed from saved blocks; if none, blocksOrDefault returns the
  // starter set so the form is never blank on first open.
  const [blocks, setBlocks] = useState(() => blocksOrDefault(initialSettings?.blocks))
  const [expanded, setExpanded] = useState(() => new Set(blocks.map((b) => b.id)))
  const [activeDragId, setActiveDragId] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  // Site chrome (mig 129) — logo lives outside the blocks array
  // because it always renders regardless of section ordering.
  // Width stored as string so the operator can clear/edit the
  // input mid-typing without it snapping to a default; coerced
  // on save (same pattern Staff required + Booking type forms use).
  const [logoUrl,     setLogoUrl]     = useState(initialSettings?.logo_url || '')
  const [logoAlt,     setLogoAlt]     = useState(initialSettings?.logo_alt || '')
  const [logoWidthPx, setLogoWidthPx] = useState(String(initialSettings?.logo_width_px || ''))

  // EVENTS-IG.1 (mig 382) — flat column outside the blocks list, like the logo.
  // Absent → default ON; only an explicit false hides the events-page IG strip.
  const [showInstagramFeed, setShowInstagramFeed] = useState(initialSettings?.show_instagram_feed !== false)

  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  // Per-key upload spinner / error so multiple file inputs across
  // multiple blocks can show their own status without trampling.
  const [uploading, setUploading] = useState({}) // { key: bool }
  const [uploadErr, setUploadErr] = useState({}) // { key: string }
  const [progress, setProgress] = useState({}) // { key: { phase, percent } | null }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const blockIds = useMemo(() => blocks.map((b) => b.id), [blocks])
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
    }
  }, [blocks, logoUrl, logoAlt, logoWidthPx, locationId])

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
          if (i < 0) return prev
          const copy = JSON.parse(JSON.stringify(prev[i]))
          copy.id = newBlockId()
          const next = prev.slice()
          next.splice(i + 1, 0, copy)
          return next
        })
      } else if (msg.type === 'delete-block' && msg.blockId) {
        // LP3c.4 — toolbar trash on a block in the iframe.
        // Confirmation already happened in the iframe.
        setBlocks((prev) => prev.filter((b) => b.id !== msg.blockId))
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
        try { added = newBlockOfType(msg.blockType) } catch { return }
        setBlocks((prev) => {
          const idx = Math.max(0, Math.min(prev.length, msg.atIndex))
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
  }, [buildState])

  // ── Block ops ─────────────────────────────────────────────
  function updateBlock(id, patch) {
    setBlocks((prev) => prev.map((b) => b.id === id ? { ...b, ...patch } : b))
  }
  function removeBlock(id) {
    setBlocks((prev) => prev.filter((b) => b.id !== id))
    setExpanded((prev) => { const next = new Set(prev); next.delete(id); return next })
  }
  function addBlock(type) {
    const block = newBlockOfType(type)
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
      const payload = {
        location_id: locationId,
        blocks,
        logo_url:      logoUrl.trim() || null,
        logo_alt:      logoAlt.trim() || null,
        logo_width_px: widthPxOrNull,
        show_instagram_feed: showInstagramFeed,
      }
      const r = await fetch('/api/landing-page-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Save failed (${r.status})`)
      setSavedAt(new Date())
    } catch (err) {
      setError(err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSave} className="xl:grid xl:grid-cols-[minmax(0,520px)_minmax(0,1fr)] xl:gap-6 xl:items-start">
      {/* Left pane — block editor (the original form). On <xl
          screens this is the entire form; on xl+ it sits beside
          the live preview iframe. */}
      <div className="space-y-4 xl:max-h-[calc(100vh-160px)] xl:overflow-y-auto xl:pr-2">
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
          <p className="text-[11px] text-un1t-muted mt-1">Logo for the top nav. Renders on every page state regardless of section ordering. Leave the logo blank to fall back to the &ldquo;UN1T&rdquo; wordmark text.</p>
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
          <Field label="Alt text" hint="What screen readers announce. Defaults to &ldquo;UN1T Dublin&rdquo; if blank.">
            <Input value={logoAlt} onChange={setLogoAlt} maxLength={200} placeholder="UN1T Dublin" />
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
            {blocks.map((block) => (
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
                  uploadMedia={uploadMedia}
                  uploading={uploading}
                  uploadErr={uploadErr}
                  progress={progress}
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
        {pickerOpen && (
          <div className="absolute z-30 left-0 right-0 mt-2 bg-un1t-surface border border-un1t-border rounded-lg shadow-xl p-2 grid grid-cols-1 md:grid-cols-2 gap-1">
            {BLOCK_TYPES.map((t) => (
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
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 bg-un1t-text text-un1t-bg font-semibold text-sm py-2 px-4 rounded-md hover:bg-un1t-accent disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
      </div>
      {/* ── Right pane — live preview iframe (xl+ screens only) ─
          Loads /welcome?edit=1, which mounts EditModeOverlay and
          re-renders from the postMessage state we push from
          buildState() above. Click any block in the iframe →
          its edit panel auto-expands + scrolls into view in the
          left pane. */}
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
    </form>
  )
}

// ─────────────────────────────────────────────────────────────
// SortableBlockCard — wraps each block with drag handle, header
// (type label + expand/delete), and the per-type edit panel below.
// ─────────────────────────────────────────────────────────────

function SortableBlockCard({
  block, expanded, onToggleExpand, onRemove, onUpdate,
  availableBookingTypes, availableEvents, uploadMedia, uploading, uploadErr, progress,
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
            uploadMedia={uploadMedia}
            uploading={uploading}
            uploadErr={uploadErr}
            progress={progress}
          />
        </div>
      )}
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
    case 'class_funnel': return block.consult_slug ? `consult: ${block.consult_slug}` : 'no consult upsell'
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
    default:            return ''
  }
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

function EventEdit({ block, onUpdate, availableEvents }) {
  const events = availableEvents || []
  const origin = (typeof window !== 'undefined' && window.location?.origin) || 'https://un1tdublin.com'
  const snippet = block.slug
    ? `<iframe src="${origin}/embed/event/${block.slug}" width="100%" height="900" style="border:0;max-width:760px" loading="lazy" title="UN1T event signup"></iframe>`
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
  return (
    <>
      <Field label="Heading">
        <Input value={block.heading || ''} onChange={(v) => onUpdate({ heading: v })} maxLength={200} placeholder="Join the founding members" />
      </Field>
      <Field label="Sub-copy" hint="Paragraph under the heading.">
        <Textarea value={block.subtext || ''} onChange={(v) => onUpdate({ subtext: v })} maxLength={600} rows={3} />
      </Field>
      <Field label="Button label">
        <Input value={block.button_label || ''} onChange={(v) => onUpdate({ button_label: v })} maxLength={60} placeholder="Join the waitlist" />
      </Field>
      <Field label="Success message" hint="Shown after a successful submit.">
        <Textarea value={block.success_message || ''} onChange={(v) => onUpdate({ success_message: v })} maxLength={300} rows={2} />
      </Field>
      <Field label="Consent checkbox text" hint="Shown beside the opt-in checkbox. Keep it explicit for GDPR — name the channels (email/SMS/WhatsApp).">
        <Textarea value={block.consent_label || ''} onChange={(v) => onUpdate({ consent_label: v })} maxLength={400} rows={3} />
      </Field>
    </>
  )
}

function ClassFunnelEdit({ block, onUpdate, availableBookingTypes }) {
  const bts = availableBookingTypes || []
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
      {block.consult_slug && (
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

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-sm text-un1t-subtle mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-un1t-muted mt-1">{hint}</p>}
    </div>
  )
}

function Input({ value, onChange, maxLength, placeholder }) {
  return (
    <input
      type="text"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      maxLength={maxLength}
      placeholder={placeholder}
      className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
    />
  )
}

function Textarea({ value, onChange, maxLength, rows, placeholder }) {
  return (
    <textarea
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      maxLength={maxLength}
      rows={rows || 2}
      placeholder={placeholder}
      className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text resize-y"
    />
  )
}

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
