'use client'

import { useState } from 'react'
import Link from 'next/link'

export default function UnsubscribePage({ token }) {
  const [status, setStatus] = useState('idle')  // idle, loading, done, error

  async function handleUnsubscribe() {
    setStatus('loading')
    try {
      const res = await fetch(`/api/unsubscribe/${token}`, { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        setStatus('done')
      } else {
        setStatus('error')
      }
    } catch {
      setStatus('error')
    }
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center">
        <h1 className="text-2xl font-bold tracking-wider mb-8">UN1T</h1>

        {status === 'idle' && (
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-8">
            <h2 className="text-lg font-semibold mb-2">Unsubscribe from emails</h2>
            <p className="text-sm text-un1t-light mb-6">
              Click below to unsubscribe from marketing emails. You will still receive essential administrative emails.
            </p>
            <button
              onClick={handleUnsubscribe}
              className="w-full bg-white text-black font-medium py-2.5 rounded-md hover:bg-gray-200 transition-colors"
            >
              Unsubscribe
            </button>
            <Link
              href={`/preferences/${token}`}
              className="block mt-4 text-sm text-un1t-light hover:text-white transition-colors"
            >
              Or manage all your communication preferences
            </Link>
          </div>
        )}

        {status === 'loading' && (
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-8">
            <p className="text-un1t-light">Processing...</p>
          </div>
        )}

        {status === 'done' && (
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-8">
            <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold mb-2">You've been unsubscribed</h2>
            <p className="text-sm text-un1t-light mb-4">
              You won't receive marketing emails from us anymore. You can re-subscribe at any time from the preference centre.
            </p>
            <Link
              href={`/preferences/${token}`}
              className="text-sm text-un1t-light hover:text-white transition-colors"
            >
              Manage preferences
            </Link>
          </div>
        )}

        {status === 'error' && (
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-8">
            <h2 className="text-lg font-semibold mb-2 text-red-400">Something went wrong</h2>
            <p className="text-sm text-un1t-light mb-4">
              We couldn't process your request. The link may be invalid or expired.
            </p>
            <button
              onClick={() => setStatus('idle')}
              className="text-sm text-un1t-light hover:text-white transition-colors"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
