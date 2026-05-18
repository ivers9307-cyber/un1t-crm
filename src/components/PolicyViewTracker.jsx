'use client'

// POLICIES-VIEWS.1 — client-side view tracking for the policy viewer.
//
// What it does on mount:
//   1. POSTs /api/policies/[slug]/views to open a view session
//      → receives a view_id.
//   2. Splits body_markdown into sections at heading boundaries
//      (same heuristic as detectSectionHeadings in src/lib/policies.js).
//   3. Renders the body inside this component, with each section
//      wrapped in a <section ref={...}> so an IntersectionObserver
//      can know which one is on screen.
//   4. Every 1s while the tab is visible, tick the dwell counter for
//      the section whose midpoint is closest to the viewport centre.
//   5. On page-leave / unload / pagehide, PATCH the view session
//      with total_duration_seconds + section_dwell map. Uses
//      navigator.sendBeacon as the unload-safe write.
//
// Idempotent server-side — the PATCH route takes max(prev, new) on
// duration, so multiple end-of-session fires (visibilitychange,
// pagehide, unmount) all converge on the longest dwell observed.

import { useEffect, useRef, useState } from 'react'

// Mirrors src/lib/policies.js#detectSectionHeadings exactly. Kept
// duplicated here rather than imported because importing a server-
// side file into a client component drags Next.js boundary errors.
function splitBodyIntoSections(body) {
  if (!body) return [{ heading: null, content: '' }]
  const lines = body.split(/\r?\n/)
  const sections = []
  let cur = { heading: null, content: [] }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    const next = (lines[i + 1] || '').trim()
    const isHeading = trimmed && next === '' && (
      /^\d+\.\s+\S/.test(trimmed) ||
      (!/[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed) && trimmed.replace(/\s+/g, '').length >= 5)
    )
    if (isHeading) {
      if (cur.content.length > 0 || cur.heading) sections.push({ heading: cur.heading, content: cur.content.join('\n') })
      cur = { heading: trimmed, content: [line] }
    } else {
      cur.content.push(line)
    }
  }
  if (cur.content.length > 0 || cur.heading) sections.push({ heading: cur.heading, content: cur.content.join('\n') })
  return sections
}

export default function PolicyViewTracker({ slug, body }) {
  const sections = splitBodyIntoSections(body)
  const sectionRefs = useRef({})
  const dwellRef = useRef(Object.create(null))    // section heading → seconds
  const totalRef = useRef(0)                       // total seconds (any section)
  const visibleSectionRef = useRef(null)           // most-centred section heading
  const viewIdRef = useRef(null)
  const lastFlushedDurationRef = useRef(0)
  const [error, setError] = useState(null)

  // Start the view session on mount; remember view_id for later
  // PATCH calls. If this fails we still render the body — view
  // tracking is best-effort.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/policies/${encodeURIComponent(slug)}/views`, { method: 'POST' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (j?.success) viewIdRef.current = j.view?.id || null
        else setError(j?.error || 'Could not start view session.')
      })
      .catch((e) => { if (!cancelled) setError(e.message || 'Network error.') })
    return () => { cancelled = true }
  }, [slug])

  // IntersectionObserver — track which section's midpoint is in the
  // viewport so we know where to credit the dwell tick. We use a
  // tall observation band (rootMargin 25%/-50%) so only one section
  // is "primary" at a time even when scrolling slowly.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const visible = new Map() // heading → ratio
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const heading = entry.target.dataset.heading
          if (!heading) continue
          if (entry.isIntersecting) visible.set(heading, entry.intersectionRatio)
          else visible.delete(heading)
        }
        // Pick the heading with the largest visible ratio.
        let best = null
        let bestRatio = 0
        for (const [h, r] of visible) {
          if (r > bestRatio) { best = h; bestRatio = r }
        }
        visibleSectionRef.current = best
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1], rootMargin: '0px 0px -50% 0px' },
    )
    for (const el of Object.values(sectionRefs.current)) {
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [sections.length])

  // flush() — declared BEFORE the useEffect that references it so
  // both the lint rule and the human reading the code see the
  // dependency cleanly. Refs are stable so this function's identity
  // doesn't need to be memoized.
  function flush() {
    const viewId = viewIdRef.current
    if (!viewId) return
    const total = totalRef.current
    if (total <= 0) return
    // Skip if we've already reported this exact duration (avoids
    // spamming the API for users who just bounced).
    if (total <= lastFlushedDurationRef.current) return
    lastFlushedDurationRef.current = total

    const body = JSON.stringify({
      view_id: viewId,
      total_duration_seconds: total,
      section_dwell: { ...dwellRef.current },
    })
    // `fetch` with `keepalive: true` is the modern unload-safe
    // write that supports PATCH. (navigator.sendBeacon would also
    // survive unload but is POST-only, so it can't talk to our
    // PATCH route.) Server-side this PATCH is idempotent — it
    // takes max(existing, new) on duration — so firing twice
    // (visibilitychange + pagehide) is safe.
    fetch(`/api/policies/${encodeURIComponent(slug)}/views`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => { /* best effort — never block the user */ })
  }

  // Ticker — every 1s while the tab is visible, increment total and
  // the current section's dwell counter.
  useEffect(() => {
    let tickerId = null
    function start() {
      if (tickerId != null) return
      tickerId = window.setInterval(() => {
        totalRef.current += 1
        const heading = visibleSectionRef.current
        if (heading) {
          dwellRef.current[heading] = (dwellRef.current[heading] || 0) + 1
        }
      }, 1000)
    }
    function stop() {
      if (tickerId != null) {
        window.clearInterval(tickerId)
        tickerId = null
      }
    }
    function onVisibility() {
      if (document.hidden) {
        stop()
        flush()
      } else {
        start()
      }
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      stop()
      flush()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
    }
    // We deliberately omit `flush` from deps — it's stable via the
    // refs it closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <article className="bg-white text-gray-900 rounded-lg p-6 md:p-8 my-6 border border-un1t-gray">
      <div className="whitespace-pre-wrap font-serif text-sm md:text-base leading-relaxed">
        {sections.map((s, i) => (
          <section
            key={i}
            ref={(el) => { if (s.heading) sectionRefs.current[s.heading] = el }}
            data-heading={s.heading || ''}
          >
            {s.content}
            {i < sections.length - 1 && '\n'}
          </section>
        ))}
      </div>
      {error && (
        <div className="mt-4 text-[11px] text-amber-700 italic">
          (Note: view tracking failed to start — {error}. You can still read this policy normally.)
        </div>
      )}
    </article>
  )
}
