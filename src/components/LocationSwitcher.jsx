'use client'

import { useRouter } from 'next/navigation'
import { MapPin, ChevronDown } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { setActiveLocation } from '@/lib/active-location'

export default function LocationSwitcher({ locations, activeLocationId }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  if (!locations || locations.length <= 1) return null

  const active = locations.find(l => l.id === activeLocationId) || locations[0]

  function switchLocation(locationId) {
    // Set the active-location cookie (the ONE shared path — see
    // src/lib/active-location.js) then refresh so getCurrentUser()
    // re-reads it server-side.
    setActiveLocation(locationId)
    setOpen(false)
    router.refresh()
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full text-left group"
      >
        <MapPin size={12} className="text-un1t-muted shrink-0" />
        <span className="text-xs text-un1t-subtle group-hover:text-un1t-text transition-colors truncate">
          {active.name}
        </span>
        <ChevronDown size={12} className={`text-un1t-muted shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-full bg-un1t-surface border border-un1t-border rounded-md shadow-lg z-50 py-1">
          {locations.map(loc => (
            <button
              key={loc.id}
              onClick={() => switchLocation(loc.id)}
              className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                loc.id === activeLocationId
                  ? 'text-un1t-text bg-un1t-border/50'
                  : 'text-un1t-subtle hover:text-un1t-text hover:bg-un1t-border/30'
              }`}
            >
              {loc.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
