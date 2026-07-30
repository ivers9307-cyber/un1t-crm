'use client'

// GEO-ATT.14 — interactive map picker for the geofence attendance card.
//
// Replaces "paste lat/long from Google Maps" as the primary picking UX:
// click the map (or drag the marker) to set the gym coordinates; an
// L.circle shows the live radius. An address search box (Nominatim, on
// submit only) recentres via the same onPick contract. Leaflet is
// browser-only, so it's dynamically imported inside useEffect — this
// component must stay a client component and is SSR-safe (renders an
// empty container on the server).
//
// Props:
//   latitude / longitude — numbers or null (parent's parsed state)
//   radiusM              — number (metres) for the circle
//   onPick({ latitude, longitude }) — fired on click / drag-end / search,
//                          rounded to 6 decimals
//   interactive          — false renders a read-only map (can_edit=false)

import 'leaflet/dist/leaflet.css'
import { useEffect, useRef, useState } from 'react'
import { Loader2, Search } from 'lucide-react'

const DUBLIN = { lat: 53.3498, lng: -6.2603 }
const PICK_ZOOM = 16
const FALLBACK_ZOOM = 11

// Same-point tolerance ~0.11 m — anything closer than this is "the value
// we just emitted echoing back", not an external change worth moving the
// marker for (avoids fighting an in-flight drag).
const EPS = 0.000001

// The VIEW recentres only for search/pick-scale moves (> ~1.1 km) or when
// the marker first appears, and only after the coords settle for
// PAN_DEBOUNCE_MS — fine-tune keystrokes in the lat/lng fields move the
// marker but must never pan the map mid-entry (typing "53.29" passes
// through latitude 5).
const PAN_THRESHOLD_DEG = 0.01
const PAN_DEBOUNCE_MS = 400

function round6(n) {
  return Math.round(n * 1e6) / 1e6
}

function markerIcon(L) {
  // L.divIcon, not the default icon — Leaflet's default marker resolves
  // its PNGs relative to the stylesheet and 404s under bundlers.
  return L.divIcon({
    className: '',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    html: '<div style="width:14px;height:14px;border-radius:9999px;background:#1E293B;border:2px solid #FFFFFF;box-shadow:0 0 0 1px #1E293B"></div>',
  })
}

export default function GeofenceMapPicker({ latitude, longitude, radiusM, onPick, interactive = true }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)       // Leaflet map instance
  const markerRef = useRef(null)
  const circleRef = useRef(null)
  const panTimerRef = useRef(null)
  const aliveRef = useRef(true)
  const onPickRef = useRef(onPick)
  useEffect(() => {
    onPickRef.current = onPick
  }, [onPick])

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchMsg, setSearchMsg] = useState(null)

  const hasCoords = Number.isFinite(latitude) && Number.isFinite(longitude)
  const radius = Number.isFinite(Number(radiusM)) && Number(radiusM) > 0 ? Number(radiusM) : 0

  // Latest props, readable from the async init (a prop change landing
  // during the dynamic-import window must not be lost) and from
  // syncLayers. Kept in step by the props effect below.
  const stateRef = useRef({ latitude, longitude, radius, hasCoords })

  // Unmount guard for the async search + any pending debounced pan.
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (panTimerRef.current) {
        clearTimeout(panTimerRef.current)
        panTimerRef.current = null
      }
    }
  }, [])

  function emitPick(latlng) {
    onPickRef.current?.({ latitude: round6(latlng.lat), longitude: round6(latlng.lng) })
  }

  function schedulePan(la, ln) {
    panTimerRef.current = setTimeout(() => {
      panTimerRef.current = null
      const map = mapRef.current
      if (!map || !aliveRef.current) return
      map.setView([la, ln], Math.max(map.getZoom(), PICK_ZOOM))
    }, PAN_DEBOUNCE_MS)
  }

  // Reconcile marker/circle/view with stateRef.current. Called from the
  // props effect and once at init-complete. Marker + circle always track
  // the coords immediately; the view pans only per the PAN_* rules above.
  // Reads refs only, so it never closes over stale props.
  function syncLayers() {
    const map = mapRef.current
    const marker = markerRef.current
    const circle = circleRef.current
    if (!map || !marker || !circle) return
    // Any pending pan targets stale coords — re-derive below.
    if (panTimerRef.current) {
      clearTimeout(panTimerRef.current)
      panTimerRef.current = null
    }
    const { latitude: la, longitude: ln, radius: r, hasCoords: has } = stateRef.current
    if (!has) {
      marker.setOpacity(0)
      if (map.hasLayer(circle)) circle.remove()
      return
    }
    const wasHidden = marker.options.opacity === 0
    marker.setOpacity(1)
    const cur = marker.getLatLng()
    const dLat = Math.abs(cur.lat - la)
    const dLng = Math.abs(cur.lng - ln)
    if (dLat > EPS || dLng > EPS) marker.setLatLng([la, ln])
    circle.setLatLng([la, ln])
    if (r > 0) {
      if (circle.getRadius() !== r) circle.setRadius(r)
      if (!map.hasLayer(circle)) circle.addTo(map)
    } else if (map.hasLayer(circle)) {
      circle.remove()
    }
    if (wasHidden || dLat > PAN_THRESHOLD_DEG || dLng > PAN_THRESHOLD_DEG) {
      schedulePan(la, ln)
    }
  }

  // Props → stateRef + layer sync. Runs before init completes too (no-op
  // on the layers then); init re-syncs from stateRef once the import
  // resolves, so nothing is lost either way.
  useEffect(() => {
    stateRef.current = { latitude, longitude, radius, hasCoords }
    syncLayers()
    // syncLayers reads refs only — stable by construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latitude, longitude, radius, hasCoords])

  // Init once (per interactivity mode); destroy on unmount.
  useEffect(() => {
    let cancelled = false
    async function init() {
      if (!containerRef.current || mapRef.current) return
      const L = (await import('leaflet')).default
      if (cancelled || !containerRef.current || mapRef.current) return

      // Read CURRENT props via stateRef, not the effect closure — they
      // may have changed while the dynamic import was in flight.
      const { latitude: la, longitude: ln, radius: r, hasCoords: has } = stateRef.current
      const center = has ? [la, ln] : [DUBLIN.lat, DUBLIN.lng]
      const map = L.map(containerRef.current, {
        center,
        zoom: has ? PICK_ZOOM : FALLBACK_ZOOM,
        dragging: interactive,
        scrollWheelZoom: interactive,
        doubleClickZoom: interactive,
        boxZoom: interactive,
        keyboard: interactive,
        touchZoom: interactive,
        zoomControl: interactive,
        attributionControl: true,
      })
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map)

      const marker = L.marker(center, {
        icon: markerIcon(L),
        draggable: interactive,
        keyboard: false,
        opacity: has ? 1 : 0,
        interactive,
      }).addTo(map)
      marker.on('drag', () => circleRef.current?.setLatLng(marker.getLatLng()))
      marker.on('dragend', () => emitPick(marker.getLatLng()))

      const circle = L.circle(center, {
        radius: r,
        color: '#1E293B',
        weight: 2,
        fillColor: '#1E293B',
        fillOpacity: 0.08,
        interactive: false,
      })
      if (has && r > 0) circle.addTo(map)

      if (interactive) {
        map.on('click', (e) => emitPick(e.latlng))
      }

      mapRef.current = map
      markerRef.current = marker
      circleRef.current = circle
      // Reconcile once more in case props moved between the stateRef
      // read above and layer creation.
      syncLayers()
    }
    init()
    return () => {
      cancelled = true
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        markerRef.current = null
        circleRef.current = null
      }
    }
    // interactive changes rebuild the map (handlers/drag flags are set at
    // init); coords/radius updates are handled by syncLayers above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive])

  async function runSearch() {
    const q = query.trim()
    if (!q || searching) return
    setSearching(true)
    setSearchMsg(null)
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`
      )
      if (!aliveRef.current) return
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const results = await res.json()
      if (!aliveRef.current) return
      const hit = Array.isArray(results) ? results[0] : null
      if (!hit) {
        setSearchMsg('No match found')
      } else {
        onPickRef.current?.({
          latitude: round6(parseFloat(hit.lat)),
          longitude: round6(parseFloat(hit.lon)),
        })
      }
    } catch {
      if (aliveRef.current) setSearchMsg('Search failed — try again or click the map')
    } finally {
      if (aliveRef.current) setSearching(false)
    }
  }

  return (
    <div className="max-w-md">
      {interactive && (
        <div className="mb-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={query}
              placeholder="Search address or place…"
              aria-label="Search address or place"
              onChange={(e) => { setQuery(e.target.value); setSearchMsg(null) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  runSearch()
                }
              }}
              className="w-full rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-xs text-un1t-text"
            />
            <button
              type="button"
              onClick={runSearch}
              disabled={searching || !query.trim()}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-un1t-border text-un1t-text hover:bg-un1t-surface disabled:opacity-50 flex-shrink-0"
            >
              {searching ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
              Search
            </button>
          </div>
          {searchMsg && <p className="mt-1 text-xs text-un1t-muted">{searchMsg}</p>}
        </div>
      )}
      <div
        ref={containerRef}
        className="w-full rounded border border-un1t-border overflow-hidden"
        style={{ height: 320 }}
        aria-label="Geofence location map"
      />
      {interactive && (
        <p className="mt-1 text-xs text-un1t-muted">
          Click the map or drag the pin to set the gym location — the circle shows the geofence radius.
        </p>
      )}
    </div>
  )
}
