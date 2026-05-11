'use client'

// EditModeOverlay — client component mounted by /welcome when the
// page is loaded in edit mode (?edit=1) inside the operator
// settings iframe. Receives blocks + chrome state from the parent
// window via postMessage and re-renders on every update so the
// preview tracks the operator's keystrokes in near-realtime.
//
// PostMessage contract (parent ↔ iframe):
//   parent → iframe:
//     { type: 'state', blocks, logoUrl, logoAlt, logoWidthPx,
//       locationId, selectedBlockId }
//   iframe → parent:
//     { type: 'ready' }                          — iframe mounted
//     { type: 'block-clicked',  blockId }        — operator clicked a block
//     { type: 'edit-field',     blockId, path, value }
//                                                — inline contentEditable typed
//     LP3c.4 additions:
//     { type: 'move-block',     blockId, direction: 'up'|'down' }
//     { type: 'duplicate-block', blockId }
//     { type: 'delete-block',   blockId }
//     { type: 'add-block',      blockType, atIndex }
//
// Origin check: same-origin only — settings page lives on the same
// Vercel project as /welcome. Anything cross-origin is dropped.
//
// The booking widget click is the one place we DON'T intercept —
// it'd be hostile to operators trying to test their booking form
// from inside the editor. The widget renders normally; clicking
// outside the widget's interactive surface still selects the
// block.

import { useState, useEffect, useRef } from 'react'
import { ArrowUp, ArrowDown, Copy, Trash2, Plus } from 'lucide-react'
import BlockRenderer, { SiteHeader, SiteFooter } from './BlockRenderers'
import { BLOCK_TYPES } from '@/lib/landing-page-blocks'

const MESSAGE_NAMESPACE = 'lp-editor'

export default function EditModeOverlay({
  initialBlocks = [],
  initialLogoUrl = null,
  initialLogoAlt = 'UN1T Dublin',
  initialLogoWidthPx = 200,
}) {
  const [blocks, setBlocks] = useState(initialBlocks)
  const [logoUrl, setLogoUrl] = useState(initialLogoUrl)
  const [logoAlt, setLogoAlt] = useState(initialLogoAlt)
  const [logoWidthPx, setLogoWidthPx] = useState(initialLogoWidthPx)
  // locationId arrives via postMessage state (the parent settings
  // form has it from getCurrentUser().activeLocation.id and pushes
  // it down so EditableImage / HeroMediaTools can attribute uploads
  // to the right tenant). Null until the first state message lands.
  const [locationId, setLocationId] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  // Index of the gap where the "+ Insert section" picker is open
  // (number) or null if no picker is open. Tracked here so only
  // ONE picker is open at a time across all gaps.
  const [pickerAtIndex, setPickerAtIndex] = useState(null)
  const blockRefs = useRef({})

  useEffect(() => {
    if (typeof window === 'undefined') return
    // Only operate when actually inside an iframe; if someone hits
    // /welcome?edit=1 directly we render the overlays but don't
    // try to talk to a parent that isn't there.
    const inIframe = window.parent !== window

    function onMessage(event) {
      // Same-origin only — the editor lives on the same Vercel
      // project as /welcome.
      if (event.origin !== window.location.origin) return
      const msg = event.data
      if (!msg || typeof msg !== 'object' || msg.namespace !== MESSAGE_NAMESPACE) return

      if (msg.type === 'state') {
        if (Array.isArray(msg.blocks)) setBlocks(msg.blocks)
        if (msg.logoUrl !== undefined)     setLogoUrl(msg.logoUrl || null)
        if (msg.logoAlt !== undefined)     setLogoAlt(msg.logoAlt || 'UN1T Dublin')
        if (msg.logoWidthPx !== undefined) setLogoWidthPx(msg.logoWidthPx || 200)
        if (msg.locationId !== undefined)  setLocationId(msg.locationId || null)
        if (msg.selectedBlockId !== undefined) {
          setSelectedId(msg.selectedBlockId || null)
          // Scroll the selected block into view so clicking it on the
          // left pane scrolls the iframe to match.
          const el = blockRefs.current[msg.selectedBlockId]
          if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        }
      }
    }
    window.addEventListener('message', onMessage)

    if (inIframe) {
      window.parent.postMessage(
        { namespace: MESSAGE_NAMESPACE, type: 'ready' },
        window.location.origin,
      )
    }

    return () => window.removeEventListener('message', onMessage)
  }, [])

  // ── PostMessage helpers ───────────────────────────────────
  // All structural edits route through the same emit() so the
  // origin / standalone guards aren't repeated.
  function emit(payload) {
    if (typeof window === 'undefined') return
    if (window.parent === window) return
    window.parent.postMessage(
      { namespace: MESSAGE_NAMESPACE, ...payload },
      window.location.origin,
    )
  }

  function selectBlock(id) {
    setSelectedId(id)
    emit({ type: 'block-clicked', blockId: id })
  }

  // Inline-edit callback wired through BlockRenderer → each block's
  // text renderers (see <E> helper in BlockRenderers.jsx). The path
  // is local to the block (e.g. ['headline'] or ['items', 2, 'title']);
  // we tack on the blockId here and post to the parent. The parent's
  // setByPath walker applies it to the blocks array.
  function emitFieldEdit(blockId, path, value) {
    emit({ type: 'edit-field', blockId, path, value })
  }

  function moveBlock(id, direction) {
    emit({ type: 'move-block', blockId: id, direction })
  }
  function duplicateBlock(id) {
    emit({ type: 'duplicate-block', blockId: id })
  }
  function deleteBlock(id, label) {
    if (typeof window !== 'undefined' && !window.confirm(`Remove this ${label} section?`)) return
    emit({ type: 'delete-block', blockId: id })
  }
  function addBlockAt(blockType, atIndex) {
    emit({ type: 'add-block', blockType, atIndex })
    setPickerAtIndex(null)
  }

  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <SiteHeader logoUrl={logoUrl} logoAlt={logoAlt} logoWidthPx={logoWidthPx} />
      {/* Insert-section gap before the very first block. The
          gaps render even on the public path? No — EditModeOverlay
          is the ONLY caller, so they're always edit-mode. */}
      <InsertGap
        index={0}
        open={pickerAtIndex === 0}
        onToggle={() => setPickerAtIndex(pickerAtIndex === 0 ? null : 0)}
        onPick={(t) => addBlockAt(t, 0)}
      />
      {blocks.map((block, i) => {
        const isSelected = selectedId === block.id
        const isFirst = i === 0
        const isLast = i === blocks.length - 1
        const blockLabel = BLOCK_TYPES.find((t) => t.type === block.type)?.label || block.type
        return (
          <div key={block.id}>
            <div
              ref={(el) => { if (el) blockRefs.current[block.id] = el }}
              onClick={(e) => {
                // Don't intercept clicks inside interactive elements
                // (booking widget, embed iframes, links, contentEditable
                // text). The block can still be selected by clicking
                // its margin / non-editable surface.
                const t = e.target
                if (t.closest('button, a, input, select, textarea, iframe, [contenteditable="true"]')) return
                e.stopPropagation()
                selectBlock(block.id)
              }}
              className={`relative group cursor-pointer transition-all duration-150 ${
                isSelected
                  ? 'outline outline-4 outline-blue-500 outline-offset-[-4px]'
                  : 'hover:outline hover:outline-2 hover:outline-blue-300/60 hover:outline-offset-[-2px]'
              }`}
            >
              <BlockRenderer block={block} onEdit={emitFieldEdit} locationId={locationId} />
              {/* Type badge — top-left, hover-revealed. */}
              <div
                className={`absolute top-2 left-2 z-30 px-2 py-1 rounded text-[10px] uppercase tracking-wider font-semibold pointer-events-none transition-opacity ${
                  isSelected ? 'opacity-100 bg-blue-500 text-white' : 'opacity-0 bg-blue-500/80 text-white group-hover:opacity-100'
                }`}
              >
                {blockLabel}
              </div>
              {/* Block toolbar — top-right, hover-revealed. Move
                  up/down, duplicate, delete. Click bubbling stopped
                  on each button so the wrapping select handler
                  doesn't fire. */}
              <BlockToolbar
                blockLabel={blockLabel}
                isSelected={isSelected}
                isFirst={isFirst}
                isLast={isLast}
                onMoveUp={() => moveBlock(block.id, 'up')}
                onMoveDown={() => moveBlock(block.id, 'down')}
                onDuplicate={() => duplicateBlock(block.id)}
                onDelete={() => deleteBlock(block.id, blockLabel)}
              />
            </div>
            {/* Insert-section gap AFTER this block. */}
            <InsertGap
              index={i + 1}
              open={pickerAtIndex === i + 1}
              onToggle={() => setPickerAtIndex(pickerAtIndex === i + 1 ? null : i + 1)}
              onPick={(t) => addBlockAt(t, i + 1)}
            />
          </div>
        )
      })}
      <SiteFooter />
    </div>
  )
}

// BlockToolbar — small floating toolbar in the top-right corner of
// each block. Hover-revealed (opacity 0 → 100 via group-hover) so
// the clean public layout isn't cluttered when the operator is just
// scanning the page. Click bubbling stopped on the toolbar wrapper
// so clicking inside doesn't also select the block.
function BlockToolbar({ blockLabel, isSelected, isFirst, isLast, onMoveUp, onMoveDown, onDuplicate, onDelete }) {
  return (
    <div
      className={`absolute top-2 right-2 z-30 flex items-center gap-0.5 bg-black/80 backdrop-blur rounded text-white transition-opacity ${
        isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      }`}
      onClick={(e) => e.stopPropagation()}
    >
      <ToolbarButton title={`Move ${blockLabel} up`}   disabled={isFirst} onClick={onMoveUp}><ArrowUp size={13} /></ToolbarButton>
      <ToolbarButton title={`Move ${blockLabel} down`} disabled={isLast}  onClick={onMoveDown}><ArrowDown size={13} /></ToolbarButton>
      <ToolbarButton title={`Duplicate ${blockLabel}`} onClick={onDuplicate}><Copy size={13} /></ToolbarButton>
      <ToolbarButton title={`Delete ${blockLabel}`} onClick={onDelete} danger><Trash2 size={13} /></ToolbarButton>
    </div>
  )
}

function ToolbarButton({ title, onClick, disabled, danger, children }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick?.() }}
      className={`px-1.5 py-1 transition-colors ${
        disabled ? 'opacity-30 cursor-not-allowed' : (danger ? 'hover:bg-red-600' : 'hover:bg-white/15')
      }`}
    >
      {children}
    </button>
  )
}

// InsertGap — narrow strip that sits between blocks (and at the
// very top + bottom). Hover reveals a "+ Add section here" pill;
// clicking opens an inline picker over the BLOCK_TYPES registry.
// The picker is positioned at the gap so the operator's eye doesn't
// have to travel — they pick what fits where they're already
// reading. Open state is hoisted in the parent so only one picker
// can be open at a time.
function InsertGap({ index, open, onToggle, onPick }) {
  return (
    <div className="relative h-2 group/gap">
      {/* Hover affordance — a horizontal blue line that thickens. */}
      <div
        className={`absolute inset-x-0 top-1/2 -translate-y-1/2 h-px transition-all ${
          open ? 'bg-blue-500 h-0.5' : 'bg-transparent group-hover/gap:bg-blue-400/40 group-hover/gap:h-0.5'
        }`}
      />
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggle() }}
        className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-30 transition-opacity ${
          open ? 'opacity-100' : 'opacity-0 group-hover/gap:opacity-100'
        }`}
      >
        <span className="inline-flex items-center gap-1 bg-blue-500 hover:bg-blue-600 text-white text-[11px] font-semibold px-2.5 py-1 rounded-full shadow-lg whitespace-nowrap">
          <Plus size={11} /> Add section here
        </span>
      </button>
      {open && (
        <div
          className="absolute left-1/2 top-1/2 mt-3 -translate-x-1/2 z-40 bg-un1t-dark border border-un1t-gray rounded-lg shadow-2xl p-2 w-[420px] max-w-[90vw] grid grid-cols-2 gap-1"
          onClick={(e) => e.stopPropagation()}
          role="menu"
          aria-label={`Insert section at position ${index + 1}`}
        >
          {BLOCK_TYPES.map((t) => (
            <button
              key={t.type}
              type="button"
              onClick={(e) => { e.stopPropagation(); onPick(t.type) }}
              className="text-left p-2 rounded hover:bg-un1t-gray/40 transition-colors"
            >
              <div className="text-xs font-semibold text-un1t-white">{t.label}</div>
              <div className="text-[10px] text-un1t-mid mt-0.5 leading-snug">{t.description}</div>
            </button>
          ))}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggle() }}
            className="col-span-2 text-[10px] text-un1t-mid hover:text-un1t-light pt-2 mt-1 border-t border-un1t-gray"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
