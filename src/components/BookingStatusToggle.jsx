'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

const statusColors = {
  confirmed: 'bg-blue-500/20 text-blue-400',
  completed: 'bg-green-500/20 text-green-400',
  cancelled: 'bg-red-500/20 text-red-400',
  no_show: 'bg-yellow-500/20 text-yellow-400',
}

const statusOptions = ['confirmed', 'completed', 'cancelled', 'no_show']

export default function BookingStatusToggle({ bookingId, currentStatus }) {
  const [status, setStatus] = useState(currentStatus)
  const [open, setOpen] = useState(false)
  const router = useRouter()

  async function updateStatus(newStatus) {
    setStatus(newStatus)
    setOpen(false)
    const db = createBrowserClient()
    await db.from('bookings').update({ status: newStatus }).eq('id', bookingId)
    router.refresh()
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`text-xs px-2.5 py-1 rounded-full ${statusColors[status] || statusColors.confirmed}`}
      >
        {status.replace('_', ' ')}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-un1t-dark border border-un1t-gray rounded-lg shadow-lg z-10 py-1 min-w-[120px]">
          {statusOptions.map(opt => (
            <button
              key={opt}
              onClick={() => updateStatus(opt)}
              className={`w-full text-left text-xs px-3 py-1.5 hover:bg-un1t-gray/50 transition-colors ${
                opt === status ? 'text-un1t-white' : 'text-un1t-light'
              }`}
            >
              {opt.replace('_', ' ')}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
