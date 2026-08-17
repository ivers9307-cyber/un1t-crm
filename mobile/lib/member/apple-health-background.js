// Apple Health auto-sync driver (iOS). Renders nothing. Subscribes to HealthKit
// workout changes — HealthKit background delivery (enabled via
// configureBackgroundTypes on connect) wakes the app and fires this, so a watch
// workout reaches UN1T within minutes without the member opening the app. Also
// runs a foreground catch-up once the member is signed in.
//
// Gated on the per-contact SecureStore connected flag AND on a loaded contact;
// the parent only renders it on iOS. Keying the connected flag/cursor by
// contact_id (and no-op'ing without one) stops a shared/hand-me-down device
// from silently uploading one member's HealthKit data under whoever signs in
// next. Device-verified (HealthKit can't be exercised in CI).

import { useEffect, useCallback } from 'react'
import * as SecureStore from 'expo-secure-store'
import { useSubscribeToChanges } from '@kingstinct/react-native-healthkit'
import { syncAppleHealth } from './apple-health-sync'
import { hkConnectedKey, hkCursorKey } from './apple-health-keys'
import { useAuth } from './contact-context'

export function AppleHealthBackgroundSync() {
  const { session, contact, loading } = useAuth()

  const runSync = useCallback(async () => {
    try {
      const contactId = contact?.id
      if (!contactId) return
      if ((await SecureStore.getItemAsync(hkConnectedKey(contactId))) !== 'true') return
      const sinceIso = (await SecureStore.getItemAsync(hkCursorKey(contactId))) || undefined
      const res = await syncAppleHealth({ sinceIso })
      if (res?.ok && res.cursor) await SecureStore.setItemAsync(hkCursorKey(contactId), res.cursor)
    } catch (e) {
      console.warn('[apple-health-bg] sync failed', e)
    }
  }, [contact?.id])

  // Foreground catch-up once signed in AND the contact is loaded.
  useEffect(() => {
    if (loading || !session || !contact?.id) return
    runSync()
  }, [loading, session, contact?.id, runSync])

  // Fire a sync on every HealthKit workout change (incl. background-delivery wakes).
  useSubscribeToChanges('HKWorkoutTypeIdentifier', (args) => {
    if (args && typeof args === 'object' && 'errorMessage' in args) {
      console.warn('[apple-health-bg] subscription error', args.errorMessage)
      return
    }
    runSync()
  })

  // Fire a sync when the member logs a new weigh-in. Background delivery for
  // bodyMass is already registered via enableAppleHealthBackground; this is the
  // in-app change-observer that reacts to it.
  useSubscribeToChanges('HKQuantityTypeIdentifierBodyMass', (args) => {
    if (args && typeof args === 'object' && 'errorMessage' in args) {
      console.warn('[apple-health-bg] bodyMass subscription error', args.errorMessage)
      return
    }
    runSync()
  })

  return null
}
