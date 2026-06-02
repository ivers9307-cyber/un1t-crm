// Catches render/runtime crashes in the app tree so a bad bundle shows
// a real error screen instead of hanging forever on the splash.
//
// Why this exists: a bad EAS Update once threw during startup render —
// the splash never handed off and the only "fix" users had was deleting
// the app (which re-pulled the same broken OTA). With this boundary, a
// startup crash now shows: the error, the running build/OTA identity
// (so support can tell which bundle is bad), a "Try again" reset, and a
// "Check for update" button that lets a *fixed* OTA self-heal the device
// without a reinstall.
//
// Note: a JS ErrorBoundary only catches JS render errors — which is
// exactly the class of bug that bricked us. Native crashes still need a
// new build. This is the right tool for the OTA-breakage case.

import React from 'react'
import { View, Text, Pressable, ScrollView } from 'react-native'
import * as Updates from 'expo-updates'
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
    // CRITICAL: hide the splash. If the crash happened before SplashGate
    // ran hideAsync(), the splash is still up and would cover this error
    // screen — i.e. the app would *look* hung even though we caught it.
    SplashScreen.hideAsync().catch(() => { /* already hidden / not mounted */ })
    // Best-effort log; in production this surfaces in EAS/device logs.
    console.error('[RootErrorBoundary] startup/render crash:', error?.message, info?.componentStack)
  }

  // Re-mount the tree — recovers from transient errors without a full
  // app kill.
  handleRetry = () => {
    this.setState({ error: null })
  }

  // Pull + apply a newer OTA bundle, then reload. This is the self-heal
  // path: after a broken update is rolled back / republished, a user
  // stuck on this screen can recover in-place instead of reinstalling.
  handleCheckForUpdate = async () => {
    this.setState({ checking: true })
    try {
      const res = await Updates.checkForUpdateAsync()
      if (res.isAvailable) {
        await Updates.fetchUpdateAsync()
        await Updates.reloadAsync() // boots the freshly-fetched bundle
        return
      }
      // Nothing newer on the server yet — just re-mount and hope the
      // error was transient.
      this.setState({ checking: false, error: null })
    } catch (e) {
      console.error('[RootErrorBoundary] update check failed:', e?.message)
      this.setState({ checking: false })
    }
  }

  render() {
    if (!this.state.error) return this.props.children

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

          <Text style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 4 }}>
            {buildSummary()}
          </Text>
          <Text style={{ fontSize: 11, color: '#9CA3AF', fontFamily: 'Courier' }} numberOfLines={4}>
            {String(this.state.error?.message || this.state.error)}
          </Text>
        </View>
      </ScrollView>
    )
  }
}
