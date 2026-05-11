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

import { useState, useMemo } from 'react'
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
  BLOCK_TYPES, blocksOrDefault, newBlockOfType,
} from '@/lib/landing-page-blocks'

export default function LandingPageSettingsForm({ locationId, initialSettings, availableBookingTypes }) {
  // Seed from saved blocks; if none, blocksOrDefault returns the
  // starter set so the form is never blank on first open.
  const [blocks, setBlocks] = useState(() => blocksOrDefault(initialSettings?.blocks))
  const [expanded, setExpanded] = useState(() => new Set(blocks.map((b) => b.id)))
  const [activeDragId, setActiveDragId] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  // Per-key upload spinner / error so multiple file inputs across
  // multiple blocks can show their own status without trampling.
  const [uploading, setUploading] = useState({}) // { key: bool }
  const [uploadErr, setUploadErr] = useState({}) // { key: string }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const blockIds = useMemo(() => blocks.map((b) => b.id), [blocks])
  const activeBlock = blocks.find((b) => b.id === activeDragId)

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
  async function uploadMedia({ file, kind, key }) {
    setUploadState(key, true, null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('location_id', locationId)
      fd.append('kind', kind)
      const r = await fetch('/api/landing-page-settings/media', { method: 'POST', body: fd })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Upload failed (${r.status})`)
      setUploadState(key, false, null)
      return j.url
    } catch (e) {
      setUploadState(key, false, e.message || 'Upload failed')
      return null
    }
  }

  // ── Save ──────────────────────────────────────────────────
  async function handleSave(e) {
    e?.preventDefault?.()
    setError(null)
    setSaving(true)
    try {
      const r = await fetch('/api/landing-page-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, blocks }),
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
    <form onSubmit={handleSave} className="space-y-4">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-3 inline-flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* Header — preview + status + collapse/expand all */}
      <div className="flex items-center justify-between gap-3 pb-2">
        <div className="flex items-center gap-3">
          <a
            href="/welcome"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300"
          >
            <ExternalLink size={13} /> Preview public page
          </a>
          <button
            type="button"
            onClick={() => setExpanded((prev) => prev.size === blocks.length ? new Set() : new Set(blocks.map(b => b.id)))}
            className="text-xs text-un1t-light hover:text-un1t-white inline-flex items-center gap-1"
          >
            <Layers size={12} /> {expanded.size === blocks.length ? 'Collapse all' : 'Expand all'}
          </button>
        </div>
        {savedAt && !saving && (
          <span className="text-xs text-emerald-700">Saved {savedAt.toLocaleTimeString('en-IE')}</span>
        )}
      </div>

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
              <SortableBlockCard
                key={block.id}
                block={block}
                expanded={expanded.has(block.id)}
                onToggleExpand={() => toggleExpanded(block.id)}
                onRemove={() => removeBlock(block.id)}
                onUpdate={(patch) => updateBlock(block.id, patch)}
                availableBookingTypes={availableBookingTypes}
                uploadMedia={uploadMedia}
                uploading={uploading}
                uploadErr={uploadErr}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay>
          {activeBlock ? (
            <div className="bg-un1t-dark border border-un1t-mid rounded-lg p-3 shadow-2xl opacity-90">
              <div className="flex items-center gap-2 text-sm text-un1t-white">
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
          className="w-full bg-un1t-dark border-2 border-dashed border-un1t-gray hover:border-un1t-mid rounded-lg py-3 text-sm text-un1t-light hover:text-un1t-white inline-flex items-center justify-center gap-2"
        >
          <Plus size={14} /> Add section
        </button>
        {pickerOpen && (
          <div className="absolute z-30 left-0 right-0 mt-2 bg-un1t-dark border border-un1t-gray rounded-lg shadow-xl p-2 grid grid-cols-1 md:grid-cols-2 gap-1">
            {BLOCK_TYPES.map((t) => (
              <button
                key={t.type}
                type="button"
                onClick={() => addBlock(t.type)}
                className="text-left p-3 rounded-md hover:bg-un1t-gray/40 transition-colors"
              >
                <div className="text-sm font-semibold text-un1t-white">{t.label}</div>
                <div className="text-[11px] text-un1t-mid mt-0.5">{t.description}</div>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              className="md:col-span-2 text-[11px] text-un1t-mid hover:text-un1t-light pt-2 mt-1 border-t border-un1t-gray"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Sticky save bar */}
      <div className="sticky bottom-4 flex items-center justify-end gap-2 bg-un1t-dark/80 backdrop-blur border border-un1t-gray rounded-md p-3">
        <a
          href="/welcome"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-un1t-light hover:text-un1t-white inline-flex items-center gap-1.5"
        >
          <ExternalLink size={12} /> Preview
        </a>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 bg-un1t-white text-un1t-black font-semibold text-sm py-2 px-4 rounded-md hover:bg-un1t-accent disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  )
}

// ─────────────────────────────────────────────────────────────
// SortableBlockCard — wraps each block with drag handle, header
// (type label + expand/delete), and the per-type edit panel below.
// ─────────────────────────────────────────────────────────────

function SortableBlockCard({
  block, expanded, onToggleExpand, onRemove, onUpdate,
  availableBookingTypes, uploadMedia, uploading, uploadErr,
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
      className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden"
    >
      <div className="flex items-center gap-2 p-3">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Drag ${labelFor(block.type)}`}
          className="cursor-grab active:cursor-grabbing text-un1t-mid hover:text-un1t-white touch-none"
          title="Drag to reorder"
        >
          <GripVertical size={16} />
        </button>
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex-1 flex items-center gap-2 text-left min-w-0"
        >
          {expanded ? <ChevronDown size={14} className="text-un1t-mid" /> : <ChevronRight size={14} className="text-un1t-mid" />}
          <span className="text-sm font-semibold text-un1t-white">{labelFor(block.type)}</span>
          <span className="text-[11px] text-un1t-mid truncate">{summaryFor(block)}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirm(`Remove this ${labelFor(block.type)} section?`)) onRemove()
          }}
          aria-label="Delete section"
          className="text-un1t-mid hover:text-red-400 p-1"
          title="Delete section"
        >
          <Trash2 size={14} />
        </button>
      </div>
      {expanded && (
        <div className="border-t border-un1t-gray p-4 space-y-3">
          <BlockEditPanel
            block={block}
            onUpdate={onUpdate}
            availableBookingTypes={availableBookingTypes}
            uploadMedia={uploadMedia}
            uploading={uploading}
            uploadErr={uploadErr}
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
    case 'pillars':     return `${(block.items || []).length} items`
    case 'gallery':     return `${(block.items || []).length} photo${(block.items || []).length === 1 ? '' : 's'}`
    case 'embed':       return block.url ? new URL(block.url).hostname.replace(/^www\./, '') : 'no URL'
    case 'stats':       return `${(block.items || []).length} stats`
    case 'testimonial': return block.author || ''
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
    case 'pillars':     return <PillarsEdit     {...props} />
    case 'gallery':     return <GalleryEdit     {...props} />
    case 'embed':       return <EmbedEdit       {...props} />
    case 'stats':       return <StatsEdit       {...props} />
    case 'testimonial': return <TestimonialEdit {...props} />
    default:            return <div className="text-xs text-red-700">Unknown block type: {props.block.type}</div>
  }
}

function HeroEdit({ block, onUpdate, uploadMedia, uploading, uploadErr }) {
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
      <Field label="Background image" hint="PNG / JPEG / WebP, ≤ 5MB. Replaces the dark gradient. The video below takes precedence; the image then becomes its poster (still frame while video loads).">
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
      <Field label="Background video" hint="MP4 / WebM, ≤ 25MB. Auto-plays muted on loop. Tip: 720p, 5-15 seconds, ~3-5Mbps.">
        <MediaSlot
          url={block.video_url || ''}
          onClear={() => onUpdate({ video_url: null })}
          onUpload={async (file) => { const url = await uploadMedia({ file, kind: 'video', key: k('video') }); if (url) onUpdate({ video_url: url }) }}
          uploading={!!uploading[k('video')]}
          error={uploadErr[k('video')]}
          accept="video/mp4,video/webm"
          label="Add video"
          kind="video"
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
          className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
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
          <div key={i} className="border border-un1t-gray rounded-md p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wider text-un1t-mid">Pillar {i + 1}</div>
              <div className="flex items-center gap-1">
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="p-1 text-un1t-mid hover:text-un1t-white disabled:opacity-30" title="Move up"><ArrowUp size={11} /></button>
                <button type="button" disabled={i === items.length - 1} onClick={() => move(i, 1)} className="p-1 text-un1t-mid hover:text-un1t-white disabled:opacity-30" title="Move down"><ArrowDown size={11} /></button>
                <button type="button" onClick={() => removeItem(i)} className="p-1 text-un1t-mid hover:text-red-400" title="Remove pillar"><Trash2 size={11} /></button>
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
              <p className="text-[11px] text-un1t-mid mb-2">Optional photo above this pillar</p>
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
        <button type="button" onClick={addItem} className="text-xs text-un1t-light hover:text-un1t-white inline-flex items-center gap-1.5">
          <Plus size={12} /> Add pillar
        </button>
      )}
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
      <Field label={`Photos (${items.length}/24)`} hint="PNG/JPEG/WebP, ≤ 5MB each.">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {items.map((g, i) => (
            <div key={i} className="relative group border border-un1t-gray rounded-md overflow-hidden bg-un1t-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={g.url} alt={g.alt || ''} className="w-full aspect-square object-cover" />
              <div className="p-2 space-y-1">
                <input
                  type="text"
                  value={g.caption || ''}
                  onChange={(e) => setItem(i, { caption: e.target.value })}
                  placeholder="Caption (optional)"
                  maxLength={400}
                  className="w-full bg-un1t-dark border border-un1t-gray rounded px-2 py-1 text-[11px] text-un1t-white"
                />
                <input
                  type="text"
                  value={g.alt || ''}
                  onChange={(e) => setItem(i, { alt: e.target.value })}
                  placeholder="Alt text (a11y)"
                  maxLength={400}
                  className="w-full bg-un1t-dark border border-un1t-gray rounded px-2 py-1 text-[11px] text-un1t-white"
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
            <label className={`bg-un1t-black border-2 border-dashed border-un1t-gray hover:border-un1t-mid rounded-md aspect-square flex flex-col items-center justify-center text-un1t-light cursor-pointer ${uploading[k] ? 'opacity-50 pointer-events-none' : ''}`}>
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
            <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="p-1 text-un1t-mid hover:text-un1t-white disabled:opacity-30" title="Move up"><ArrowUp size={11} /></button>
            <button type="button" disabled={i === items.length - 1} onClick={() => move(i, 1)} className="p-1 text-un1t-mid hover:text-un1t-white disabled:opacity-30" title="Move down"><ArrowDown size={11} /></button>
            <button type="button" onClick={() => removeItem(i)} className="p-1 text-un1t-mid hover:text-red-400" title="Remove stat"><Trash2 size={11} /></button>
          </div>
        </div>
      ))}
      {items.length < 6 && (
        <button type="button" onClick={addItem} className="text-xs text-un1t-light hover:text-un1t-white inline-flex items-center gap-1.5">
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

// ─────────────────────────────────────────────────────────────
// Helpers — input primitives + uniform media-upload tile
// ─────────────────────────────────────────────────────────────

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-sm text-un1t-light mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-un1t-mid mt-1">{hint}</p>}
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
      className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
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
      className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white resize-y"
    />
  )
}

function MediaSlot({ url, onClear, onUpload, uploading, error, accept, label, kind }) {
  return (
    <div className="flex flex-col gap-1">
      {url ? (
        <div className="relative inline-block">
          {kind === 'video' ? (
            <video src={url} className="w-40 h-24 object-cover rounded-md border border-un1t-gray bg-black" muted playsInline autoPlay loop />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt="Preview" className="w-40 h-24 object-cover rounded-md border border-un1t-gray" />
          )}
          <button
            type="button"
            onClick={onClear}
            className="absolute -top-2 -right-2 bg-un1t-dark border border-un1t-gray rounded-full p-1 text-un1t-light hover:text-red-500"
            title="Clear"
          >
            <XIcon size={11} />
          </button>
        </div>
      ) : (
        <label className={`bg-un1t-black border-2 border-dashed border-un1t-gray hover:border-un1t-mid rounded-md w-40 h-24 flex flex-col items-center justify-center text-un1t-light cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
          {uploading
            ? <Loader2 size={18} className="animate-spin" />
            : (kind === 'video' ? <Video size={18} /> : <ImagePlus size={18} />)}
          <span className="text-[10px] mt-1">{uploading ? 'Uploading…' : label}</span>
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
