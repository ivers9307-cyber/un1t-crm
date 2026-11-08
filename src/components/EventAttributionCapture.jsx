'use client'
// HOSTSTATS.1 — remember the tab's first touch (utm_*, the host-campaign
// `hc`, the referrer, a random session id) so a visitor who arrives on
// /h/<slug> or /event/<slug> and books a few clicks later still carries the
// link that brought them. Renders nothing; a storage failure is silent.
import { useEffect } from 'react'
import { rememberEventAttribution } from '@/lib/event-attribution'

export default function EventAttributionCapture() {
  useEffect(() => { rememberEventAttribution() }, [])
  return null
}
