'use client'

import { useRouter } from 'next/navigation'
import { MapPin, ChevronDown } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'

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
    // Set cookie (expires in 1 year)
    document.cookie = `un1t_active_location=${locationId}; path=/; max-age=${365 * 24 * 60 * 60}; SameSite=Lax`
    setOpen(false)
    router.refresh()
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full text-left group"
      >
        <MapPin size={12} className="text-un1t-mid shrink-0" />
        <span className="text-xs text-un1t-light group-hover:text-white transition-colors truncate">
          {active.name}
        </span>
        <ChevronDown size={12} className={`text-un1t-mid shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-full bg-un1t-dark border border-un1t-gray rounded-md shadow-lg z-50 py-1">
          {locations.map(loc => (
            <button
              key={loc.id}
              onClick={() => switchLocation(loc.id)}
              className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                loc.id === activeLocationId
                  ? 'text-white bg-un1t-gray/50'
                  : 'text-un1t-light hover:text-white hover:bg-un1t-gray/30'
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
