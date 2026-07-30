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
// we just emitted echoing back", not an external change worth recentring
// for (avoids fighting an in-flight drag).
const EPS = 0.000001

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
  const onPickRef = useRef(onPick)
  useEffect(() => {
    onPickRef.current = onPick
  }, [onPick])

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchMsg, setSearchMsg] = useState(null)

  const hasCoords = Number.isFinite(latitude) && Number.isFinite(longitude)
  const radius = Number.isFinite(Number(radiusM)) && Number(radiusM) > 0 ? Number(radiusM) : 0

  function emitPick(latlng) {
    onPickRef.current?.({ latitude: round6(latlng.lat), longitude: round6(latlng.lng) })
  }

  // Init once (per interactivity mode); destroy on unmount.
  useEffect(() => {
    let cancelled = false
    async function init() {
      if (!containerRef.current || mapRef.current) return
      const L = (await import('leaflet')).default
      if (cancelled || !containerRef.current || mapRef.current) return

      const center = hasCoords ? [latitude, longitude] : [DUBLIN.lat, DUBLIN.lng]
      const map = L.map(containerRef.current, {
        center,
        zoom: hasCoords ? PICK_ZOOM : FALLBACK_ZOOM,
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
        opacity: hasCoords ? 1 : 0,
        interactive,
      }).addTo(map)
      marker.on('dragend', () => emitPick(marker.getLatLng()))

      const circle = L.circle(center, {
        radius,
        color: '#1E293B',
        weight: 2,
        fillColor: '#1E293B',
        fillOpacity: 0.08,
        interactive: false,
      })
      if (hasCoords && radius > 0) circle.addTo(map)

      if (interactive) {
        map.on('click', (e) => emitPick(e.latlng))
      }

      mapRef.current = map
      markerRef.current = marker
      circleRef.current = circle
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
    // init); coords/radius updates are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive])

  // External coord changes (search, manual field edit, load) → move
  // marker + circle + view, but only when meaningfully different so a
  // drag's own echo doesn't recentre under the user.
  useEffect(() => {
    const map = mapRef.current
    const marker = markerRef.current
    const circle = circleRef.current
    if (!map || !marker || !circle) return
    if (!hasCoords) {
      marker.setOpacity(0)
      if (map.hasLayer(circle)) circle.remove()
      return
    }
    marker.setOpacity(1)
    const cur = marker.getLatLng()
    const changed = Math.abs(cur.lat - latitude) > EPS || Math.abs(cur.lng - longitude) > EPS
    if (changed) {
      marker.setLatLng([latitude, longitude])
      map.setView([latitude, longitude], Math.max(map.getZoom(), PICK_ZOOM))
    }
    circle.setLatLng([latitude, longitude])
    if (radius > 0 && !map.hasLayer(circle)) circle.addTo(map)
  }, [latitude, longitude, hasCoords, radius])

  // Radius prop → live circle update (no re-init).
  useEffect(() => {
    const map = mapRef.current
    const circle = circleRef.current
    if (!map || !circle) return
    if (radius > 0) {
      circle.setRadius(radius)
      if (hasCoords && !map.hasLayer(circle)) circle.addTo(map)
    } else if (map.hasLayer(circle)) {
      circle.remove()
    }
  }, [radius, hasCoords])

  async function runSearch() {
    const q = query.trim()
    if (!q || searching) return
    setSearching(true)
    setSearchMsg(null)
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const results = await res.json()
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
      setSearchMsg('Search failed — try again or click the map')
    } finally {
      setSearching(false)
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
