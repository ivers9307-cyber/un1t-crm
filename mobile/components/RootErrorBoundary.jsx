// Catches render/runtime crashes so a bad bundle shows a real error
// screen instead of hanging on the splash.
//
// HARDENED (2026-06): no top-level expo-updates import. The first
// version imported it at module top; a prod OTA carrying it crashed on
// boot via expo-updates' error-recovery queue. expo-updates is now
// lazy-require'd ONLY inside the "Check for update" handler (user-
// initiated, well after launch), wrapped in try/catch. The boundary
// itself no longer touches expo-updates at mount/import time — so even
// if that module is unhappy, the boundary can still render.
//
// Caveat (unchanged): a JS ErrorBoundary only catches errors thrown
// during React *render*. A throw at module-eval/import time crashes the
// bundle before any render and CANNOT be caught here — which is exactly
// why neither this file nor build-info.js imports expo-updates at the
// top level anymore.

import React from 'react'
import { View, Text, Pressable, ScrollView } from 'react-native'
import * as SplashScreen from 'expo-splash-screen'
import { buildSummary } from '../lib/build-info'

export default class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, checking: false }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // CRITICAL: hide the splash, or this error screen renders UNDER it
    // and the app still *looks* hung even though we caught the error.
    try { SplashScreen.hideAsync().catch(() => {}) } catch { /* ignore */ }
    console.error('[RootErrorBoundary] render crash:', error?.message, info?.componentStack)
  }

  handleRetry = () => {
    this.setState({ error: null })
  }

  // Pull + apply a newer OTA, then reload — the self-heal path. Lazy-
  // requires expo-updates ONLY here (user tap, post-launch), fully
  // guarded so a failure just resets the checking state.
  handleCheckForUpdate = async () => {
    this.setState({ checking: true })
    try {
      // eslint-disable-next-line global-require
      const Updates = require('expo-updates')
      const res = await Updates.checkForUpdateAsync()
      if (res?.isAvailable) {
        await Updates.fetchUpdateAsync()
        await Updates.reloadAsync()
        return
      }
      this.setState({ checking: false, error: null })
    } catch (e) {
      console.error('[RootErrorBoundary] update check failed:', e?.message)
      this.setState({ checking: false })
    }
  }

  render() {
    if (!this.state.error) return this.props.children

    let summary = ''
    try { summary = buildSummary() } catch { summary = 'build info unavailable' }

    return (
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }}
        style={{ flex: 1, backgroundColor: '#FFFFFF' }}
      >
        <View>
          <Text style={{ fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 8 }}>
            Something went wrong
          </Text>
          <Text style={{ fontSize: 15, color: '#4B5563', marginBottom: 20, lineHeight: 21 }}>
            The app hit an error while loading. Try again, or check for an update — a fix may already be available.
          </Text>

          <Pressable
            onPress={this.handleRetry}
            style={{ backgroundColor: '#111827', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 12 }}
          >
            <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>Try again</Text>
          </Pressable>

          <Pressable
            onPress={this.handleCheckForUpdate}
            disabled={this.state.checking}
            style={{ borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 24, opacity: this.state.checking ? 0.5 : 1 }}
          >
            <Text style={{ color: '#111827', fontSize: 16, fontWeight: '600' }}>
              {this.state.checking ? 'Checking…' : 'Check for update'}
            </Text>
          </Pressable>

          <Text style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 4 }}>{summary}</Text>
          <Text style={{ fontSize: 11, color: '#9CA3AF', fontFamily: 'Courier' }} numberOfLines={4}>
            {String(this.state.error?.message || this.state.error)}
          </Text>
        </View>
      </ScrollView>
    )
  }
}
