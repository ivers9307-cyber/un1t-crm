// Biometric app-lock provider. Sits inside AuthProvider (needs `session`),
// wraps the Stack, and renders the LockScreen overlay on top when locked —
// the app underneath is never unmounted (root-layout navigation-context race).
import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import { AppState, View, Text, Pressable, Modal } from 'react-native'
import { useAuth } from './auth-context'
import {
  getBiometricCapability, runBiometricAuth, isLockEnabled, setLockEnabledPref,
  wasPromptAsked, markPromptAsked,
} from './biometric'
import { shouldRelock, biometricLabel, RELOCK_GRACE_MS } from './biometric-lock-logic'
import LockScreen from '../components/LockScreen'
import { useStudioPin } from './studio-pin'

const BiometricLockContext = createContext(null)

export function useBiometricLock() {
  return useContext(BiometricLockContext) || {
    available: false, typeLabel: 'biometrics', enabled: false,
    setEnabled: async () => ({ success: false }), lockState: 'unlocked', unlock: async () => {},
  }
}

export function BiometricLockProvider({ children }) {
  const { session } = useAuth()
  const { paired } = useStudioPin()
  const [available, setAvailable] = useState(false)
  const [typeLabel, setTypeLabel] = useState('biometrics')
  const [enabled, setEnabledState] = useState(false)
  const [lockState, setLockState] = useState('unlocked') // 'checking' | 'locked' | 'unlocked'
  const [promptVisible, setPromptVisible] = useState(false)
  const lastBg = useRef(null)
  const booted = useRef(false)

  // Capability — once.
  useEffect(() => {
    let alive = true
    getBiometricCapability().then(({ available: a, types }) => {
      if (!alive) return
      setAvailable(a)
      setTypeLabel(biometricLabel(types))
    })
    return () => { alive = false }
  }, [])

  const promptUnlock = useCallback(async () => {
    const { success } = await runBiometricAuth('Unlock CF Studio')
    if (success) setLockState('unlocked')
    // else: stay locked — LockScreen shows Unlock (retry) + Sign out.
  }, [])

  // Cold-start: decide the lock state from the stored pref the first time a
  // session is present. Resets on sign-out so a later sign-in re-evaluates.
  useEffect(() => {
    if (!session || paired) { booted.current = false; setLockState('unlocked'); return }
    if (booted.current) return
    booted.current = true
    setLockState('checking')
    ;(async () => {
      const on = await isLockEnabled()
      setEnabledState(on)
      if (on) { setLockState('locked'); promptUnlock() }
      else setLockState('unlocked')
    })()
  }, [session, paired, promptUnlock])

  // Re-lock on resume after the grace window.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        lastBg.current = Date.now()
      } else if (next === 'active') {
        if (enabled && session && !paired && shouldRelock(lastBg.current, Date.now(), RELOCK_GRACE_MS)) {
          setLockState('locked')
          promptUnlock()
        }
        lastBg.current = null
      }
    })
    return () => sub.remove()
  }, [enabled, session, paired, promptUnlock])

  // One-time enable prompt — first eligible foreground.
  useEffect(() => {
    if (!session || paired || !available || enabled || lockState !== 'unlocked') return
    let alive = true
    wasPromptAsked().then((asked) => { if (alive && !asked) setPromptVisible(true) })
    return () => { alive = false }
  }, [session, available, paired, enabled, lockState])

  // Toggle from settings — re-auth before changing the pref.
  const setEnabled = useCallback(async (on) => {
    const { success } = await runBiometricAuth(on ? `Enable ${typeLabel} lock` : `Disable ${typeLabel} lock`)
    if (!success) return { success: false }
    await setLockEnabledPref(on)
    setEnabledState(on)
    return { success: true }
  }, [typeLabel])

  const onEnableFromPrompt = useCallback(async () => {
    setPromptVisible(false)
    await markPromptAsked()
    const { success } = await runBiometricAuth(`Enable ${typeLabel} lock`)
    if (success) { await setLockEnabledPref(true); setEnabledState(true) }
  }, [typeLabel])

  const onDeclinePrompt = useCallback(async () => {
    setPromptVisible(false)
    await markPromptAsked()
  }, [])

  return (
    <BiometricLockContext.Provider value={{ available, typeLabel, enabled, setEnabled, lockState, unlock: promptUnlock }}>
      {children}
      {lockState !== 'unlocked' && (
        <LockScreen typeLabel={typeLabel} checking={lockState === 'checking'} onUnlock={promptUnlock} />
      )}
      <Modal visible={promptVisible} animationType="fade" transparent onRequestClose={onDeclinePrompt}>
        <View className="flex-1 items-center justify-center bg-black/50 px-8">
          <View className="bg-un1t-bg rounded-3xl p-6 w-full max-w-[340px]">
            <Text className="text-lg font-bold text-un1t-text mb-1">Protect CF Studio with {typeLabel}?</Text>
            <Text className="text-sm text-un1t-subtle mb-5">Require {typeLabel} to open the app and after 5 minutes away. You can change this any time in More.</Text>
            <Pressable onPress={onEnableFromPrompt}
              className="bg-un1t-text rounded-2xl py-3.5 items-center active:opacity-80">
              <Text className="text-base font-semibold text-un1t-bg">Enable {typeLabel}</Text>
            </Pressable>
            <Pressable onPress={onDeclinePrompt} className="py-3 items-center mt-1 active:opacity-70">
              <Text className="text-sm text-un1t-subtle">Not now</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </BiometricLockContext.Provider>
  )
}
