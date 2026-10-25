// src/lib/use-viewer-zone.js — TZ.16 (D3 = A). The viewer's browser zone, for
// formatRecordTime's suffix rule (src/lib/record-time.js), in a client
// component.
//
// null on the server render and during hydration (getServerSnapshot), the
// browser's canonical zone after it, so a suffix never makes the server and
// client text disagree. browserZone() also answers null for UTC (privacy
// modes report it, and no studio runs on UTC): an unknown viewer, no suffix.
import { useSyncExternalStore } from 'react'
import { browserZone } from '@/lib/timezone-options'

const subscribe = () => () => {}
const clientZone = () => browserZone()
const serverZone = () => null

/** @returns {string|null} */
export function useViewerZone() {
  return useSyncExternalStore(subscribe, clientZone, serverZone)
}
