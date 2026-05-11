'use client'

// EditModeOverlay — client component mounted by /welcome when the
// page is loaded in edit mode (?edit=1) inside the operator
// settings iframe. Receives blocks + chrome state from the parent
// window via postMessage and re-renders on every update so the
// preview tracks the operator's keystrokes in near-realtime.
//
// PostMessage contract (parent ↔ iframe):
//   parent → iframe:
//     { type: 'state', blocks, logoUrl, logoAlt, logoWidthPx, selectedBlockId }
//   iframe → parent:
//     { type: 'ready' }                          — iframe mounted, please send state
//     { type: 'block-clicked', blockId }         — operator clicked a block
//
// Origin check: we accept messages from the same origin only — the
// settings page lives on the same Vercel project as /welcome, so
// the iframe and parent share an origin. Anything cross-origin is
// dropped silently.
//
// The booking widget click is the one place we DON'T intercept —
// it'd be hostile to operators trying to test their booking form
// from inside the editor. The widget renders normally; clicking
// outside the widget's interactive surface still selects the
// block.

import { useState, useEffect, useRef } from 'react'
import BlockRenderer, { SiteHeader, SiteFooter } from './BlockRenderers'

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
  const [selectedId, setSelectedId] = useState(null)
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

  function selectBlock(id) {
    setSelectedId(id)
    if (typeof window === 'undefined') return
    if (window.parent === window) return // standalone, nobody to tell
    window.parent.postMessage(
      { namespace: MESSAGE_NAMESPACE, type: 'block-clicked', blockId: id },
      window.location.origin,
    )
  }

  // Inline-edit callback wired through BlockRenderer → each block's
  // text renderers (see <E> helper in BlockRenderers.jsx). The path
  // is local to the block (e.g. ['headline'] or ['items', 2, 'title']);
  // we tack on the blockId here and post to the parent. The parent's
  // setByPath walker applies it to the blocks array.
  function emitFieldEdit(blockId, path, value) {
    if (typeof window === 'undefined') return
    if (window.parent === window) return
    window.parent.postMessage(
      { namespace: MESSAGE_NAMESPACE, type: 'edit-field', blockId, path, value },
      window.location.origin,
    )
  }

  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <SiteHeader logoUrl={logoUrl} logoAlt={logoAlt} logoWidthPx={logoWidthPx} />
      {blocks.map((block) => {
        const isSelected = selectedId === block.id
        return (
          <div
            key={block.id}
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
            className={`relative cursor-pointer transition-all duration-150 ${
              isSelected
                ? 'outline outline-4 outline-blue-500 outline-offset-[-4px]'
                : 'hover:outline hover:outline-2 hover:outline-blue-300/60 hover:outline-offset-[-2px]'
            }`}
          >
            <BlockRenderer block={block} onEdit={emitFieldEdit} />
            {/* Type badge — top-left, only shows on hover or when
                selected. Click-through to select via the wrapper. */}
            <div
              className={`absolute top-2 left-2 z-30 px-2 py-1 rounded text-[10px] uppercase tracking-wider font-semibold pointer-events-none transition-opacity ${
                isSelected
                  ? 'opacity-100 bg-blue-500 text-white'
                  : 'opacity-0 bg-blue-500/80 text-white'
              } group-hover:opacity-100`}
            >
              {block.type}
            </div>
          </div>
        )
      })}
      <SiteFooter />
    </div>
  )
}
