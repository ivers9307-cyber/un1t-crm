'use client'

import { useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { useRouter } from 'next/navigation'

export default function ActivityToggle({ activityId, done }) {
  const [checked, setChecked] = useState(done)
  const router = useRouter()

  async function toggle() {
    const newVal = !checked
    setChecked(newVal)
    const db = createBrowserClient()
    await db.from('activities').update({ done: newVal }).eq('id', activityId)
    router.refresh()
  }

  return (
    <button onClick={toggle} className="mt-1 shrink-0">
      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
        checked ? 'bg-green-500 border-green-500' : 'border-un1t-muted hover:border-un1t-text'
      }`}>
        {checked && <span className="text-un1t-text text-xs">&#10003;</span>}
      </div>
    </button>
  )
}
