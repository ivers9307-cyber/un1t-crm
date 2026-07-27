'use client'

// TV.1 — fullscreen display client for UC Cast Pro.
//
// Polls /api/public/tv/[token]/content every 3s. Re-renders only
// when content.pushed_at changes (so a steady-state poll is cheap).
// Renders one of:
//   - <img>          for source_type 'storage' or 'url'
//   - TemplateCanvas for source_type 'template' (TV-TEMPLATE.1) —
//                    a fixed base image with text zones overlaid
//   - HyroxBoard     for source_type 'generated' (HYROX-TC.3) —
//                    the purpose-built portrait Hyrox board
//   - Idle view      (UN1T mark + live clock) if no content row
//
// TV-ROTATION.1 — the whole stage is counter-rotated by
// display.rotation degrees so content designed landscape fills a
// panel that's been hung portrait (or upside-down). 0 = normal.

import { useEffect, useState, useRef } from 'react'
import TemplateCanvas from '@/components/TemplateCanvas'
import HyroxBoard from '@/components/HyroxBoard'
import { tvFontFamily } from '@/components/tv-font'

// Content-push display (near-static); runs all day — keep the poll relaxed
// to limit Vercel Fluid-compute cost.
const POLL_MS = 6000

export default function TVDisplay({ token, initial }) {
  // `data` is the server-rendered snapshot. It never changes in
  // place — when the poll sees a new push the page hard-reloads
  // (see below), so the only state that moves here is the clock.
  const [data] = useState(initial)
  const [now, setNow] = useState(new Date())
  const lastPushedAtRef = useRef(initial?.content?.pushed_at || null)
  const lastRotationRef = useRef(initial?.display?.rotation ?? 0)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        // Cache-bust the poll: the UC Cast Pro browser (and any
        // proxy in front of it) was serving a stale response, so a
        // push wasn't seen until someone manually refreshed.
        const res = await fetch(
          `/api/public/tv/${token}/content?_=${Date.now()}`,
          { cache: 'no-store' },
        )
        if (!res.ok) return
        const j = await res.json()
        const newPushedAt = j?.content?.pushed_at || null
        const newRotation = j?.display?.rotation ?? 0
        // A new push (or orientation change) → hard-reload so the
        // cast re-renders the new content from a clean server
        // render. In-place state updates proved unreliable on the
        // cast's browser; a full reload is bulletproof, and the
        // brief flash is fine for a panel that changes rarely.
        if (newPushedAt !== lastPushedAtRef.current || newRotation !== lastRotationRef.current) {
          lastPushedAtRef.current = newPushedAt
          lastRotationRef.current = newRotation
          if (!cancelled) window.location.reload()
        }
      } catch {
        // network blip — retry next tick
      }
    }
    const handle = setInterval(tick, POLL_MS)
    return () => { cancelled = true; clearInterval(handle) }
  }, [token])

  useEffect(() => {
    const handle = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(handle)
  }, [])

  const content = data?.content
  const rotation = data?.display?.rotation ?? 0

  // The stage carries the rotation. For 90/270 the rotated element's
  // own axes are swapped relative to the viewport, so it has to be
  // sized height-for-width (100vh wide, 100vw tall) and pinned to
  // the centre — otherwise the rotated box hangs off the screen.
  const quarterTurn = rotation === 90 || rotation === 270
  const stageStyle = quarterTurn
    ? {
        position: 'absolute',
        top: '50%',
        left: '50%',
        width: '100vh',
        height: '100vw',
        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        transformOrigin: 'center center',
        // container-type makes the stage box the reference for the
        // cqh/cqw units the idle view uses, so the clock stays
        // correctly proportioned to the panel after rotation.
        containerType: 'size',
      }
    : {
        position: 'absolute',
        inset: 0,
        transform: rotation === 180 ? 'rotate(180deg)' : 'none',
        transformOrigin: 'center center',
        containerType: 'size',
      }

  let body
  if (content?.source_type === 'template' && content?.resolved_url) {
    body = <TemplateCanvas content={content} />
  } else if (content?.source_type === 'generated' && content?.board) {
    body = <HyroxBoard board={content.board} />
  } else if (content?.resolved_url) {
    body = (
      <img
        src={`${content.resolved_url}${content.resolved_url.includes('?') ? '&' : '?'}t=${encodeURIComponent(content.pushed_at)}`}
        alt={content.label || ''}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
        }}
      />
    )
  } else {
    body = (
      <IdleView
        now={now}
        logoUrl={data?.display?.logo_url}
        companyName={data?.display?.company_name}
      />
    )
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        overflow: 'hidden',
        color: '#fff',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
      }}
    >
      <div style={stageStyle}>{body}</div>
    </div>
  )
}

function IdleView({ now, logoUrl, companyName }) {
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const day = now.toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })
  // TV-IDLE-LOGO — show the location's brand logo in place of the
  // hard-coded wordmark. The idle screen is white-on-black, but the
  // stored logo (the same asset used on invoice/contract emails,
  // which sit on WHITE) is typically dark ink on transparent — it
  // would vanish on black. So we probe the asset's luminance once
  // and invert a dark logo to render it white, matching the clock; a
  // light logo is left as-is. No logo (or a load error) → fall back
  // to the company-name wordmark. The probe is best-effort: it needs
  // CORS (Supabase public storage sends ACAO:*), and on any failure
  // we simply don't invert.
  const [logoOk, setLogoOk] = useState(Boolean(logoUrl))
  const [invert, setInvert] = useState(false)

  useEffect(() => {
    if (!logoUrl) return undefined
    let cancelled = false
    const probe = new Image()
    probe.crossOrigin = 'anonymous'
    probe.onload = () => {
      try {
        const w = 64
        const h = Math.max(1, Math.round(w * (probe.naturalHeight / probe.naturalWidth || 0.4)))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(probe, 0, 0, w, h)
        const { data } = ctx.getImageData(0, 0, w, h)
        let lum = 0
        let weight = 0
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3] / 255
          if (a < 0.1) continue // ignore transparent pixels
          lum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) * a
          weight += a
        }
        const avg = weight ? lum / weight : 255
        if (!cancelled) setInvert(avg < 110) // dark ink → invert to show on black
      } catch {
        // canvas tainted / unreadable — leave the logo un-inverted
      }
    }
    probe.src = logoUrl
    return () => { cancelled = true }
  }, [logoUrl])

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '5cqh',
      }}
    >
      {/* cqh = 1% of the stage box height. The stage is already
          oriented to the panel, so these track the panel whichever
          way the TV is rotated (matches the old vh values 1:1 in
          the landscape case).
          TV-TEMPLATE.7 — brand font on the idle view too, so it
          matches the template zones instead of just falling back to
          the outer wrapper's system-ui stack. */}
      {logoOk ? (
        <img
          src={logoUrl}
          alt={companyName || ''}
          onError={() => setLogoOk(false)}
          style={{
            maxHeight: '20cqh',
            maxWidth: '72cqw',
            width: 'auto',
            height: 'auto',
            objectFit: 'contain',
            filter: invert ? 'invert(1)' : 'none',
          }}
        />
      ) : (
        <div style={{ fontSize: '12cqh', fontWeight: 900, letterSpacing: '0.2em', fontFamily: tvFontFamily }}>
          {companyName || 'UN1T'}
        </div>
      )}
      <div style={{ fontSize: '18cqh', fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1, fontFamily: tvFontFamily }}>
        {hh}:{mm}
      </div>
      <div style={{ fontSize: '3.5cqh', color: '#888', letterSpacing: '0.1em', fontFamily: tvFontFamily }}>
        {day}
      </div>
    </div>
  )
}
