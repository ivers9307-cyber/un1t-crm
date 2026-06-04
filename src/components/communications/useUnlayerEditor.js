'use client'

// PILLAR2 — Unlayer (window.unlayer global) lifecycle extracted from the proven
// CampaignEditor flow, for the unified composer's INLINE email design. Faithful
// copy: CDN script load → init on a mount div → exportHtml with the 2.5s timeout
// fallback (the callback never fires if the iframe isn't mounted). Visual-only;
// the full campaign editor keeps code-mode + the advanced toggles. Use a UNIQUE
// mountId so it can never collide with another Unlayer instance's global init.
import { useCallback, useEffect, useRef, useState } from 'react'

const MERGE_TAGS = [
  { name: 'First Name', value: '{{first_name}}' },
  { name: 'Last Name', value: '{{last_name}}' },
  { name: 'Full Name', value: '{{name}}' },
  { name: 'Email', value: '{{email}}' },
  { name: 'Phone', value: '{{phone}}' },
  { name: 'Pipeline Stage', value: '{{pipeline_stage}}' },
  { name: 'Location', value: '{{location_name}}' },
  { name: 'Unsubscribe', value: '{{unsubscribe_url}}' },
  { name: 'Preferences', value: '{{preference_url}}' },
  { name: 'Year', value: '{{current_year}}' },
]

export function useUnlayerEditor({ mountId, active = true } = {}) {
  const [loaded, setLoaded] = useState(false)
  const ref = useRef(null)

  // Load the Unlayer embed script once (shared global across the app).
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.unlayer) { setLoaded(true); return }
    const existing = document.querySelector('script[src="https://editor.unlayer.com/embed.js"]')
    if (existing) {
      const onLoad = () => setLoaded(true)
      existing.addEventListener('load', onLoad)
      if (window.unlayer) setLoaded(true)
      return () => existing.removeEventListener('load', onLoad)
    }
    const script = document.createElement('script')
    script.src = 'https://editor.unlayer.com/embed.js'
    script.async = true
    script.onload = () => setLoaded(true)
    document.body.appendChild(script)
  }, [])

  // Init the editor once the script is ready, this instance is active, and the
  // mount node exists. (Re-mounting the node — e.g. switching channels away and
  // back — re-inits fresh; the composer treats that as a reset.)
  useEffect(() => {
    if (!loaded || !active || !ref.current || !window.unlayer) return
    ref.current.replaceChildren() // clear any previous instance (safe DOM clear)
    window.unlayer.init({
      id: mountId,
      projectId: undefined,
      displayMode: 'email',
      appearance: { theme: 'dark', panels: { tools: { dock: 'left' } } },
      tools: {
        image: { enabled: true }, button: { enabled: true }, divider: { enabled: true },
        heading: { enabled: true }, html: { enabled: true }, menu: { enabled: true },
        social: { enabled: true }, text: { enabled: true }, timer: { enabled: true }, video: { enabled: true },
      },
      mergeTags: MERGE_TAGS,
      features: { textEditor: { spellChecker: true } },
    })
  }, [loaded, active, mountId])

  // Export the current HTML + design. The 2.5s timeout mirrors CampaignEditor —
  // the callback never fires if the iframe isn't mounted, which would otherwise
  // hang the send button forever.
  const exportHtml = useCallback(() => new Promise((resolve) => {
    if (!window.unlayer || typeof window.unlayer.exportHtml !== 'function') {
      resolve({ html: '', design: null }); return
    }
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ html: '', design: null }) } }, 2500)
    try {
      window.unlayer.exportHtml((data) => {
        if (done) return
        done = true; clearTimeout(timer)
        resolve({ html: data?.html ?? '', design: data?.design ?? null })
      })
    } catch {
      if (!done) { done = true; clearTimeout(timer); resolve({ html: '', design: null }) }
    }
  }), [])

  return { ref, loaded, exportHtml }
}
