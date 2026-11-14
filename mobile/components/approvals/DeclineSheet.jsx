// Reason sheet for declining an approval. `requireReason` (expenses + invoices)
// disables Confirm until non-empty; optional for time-off/swaps.
// APPROVALSQ.2 — `mode="clear"`: close a Mia request WITHOUT messaging the
// customer. Same sheet, its own title, helper, optional booking warning
// (`warn`) and confirm label. Default mode renders exactly as before.
import { useState, useEffect } from 'react'
import { View, Text, Pressable, Modal, TextInput, KeyboardAvoidingView, Platform } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { CLEAR_WARNING } from '../../lib/approval-clear'

export default function DeclineSheet({ visible, requireReason, onConfirm, onClose, mode, warn }) {
  const clear = mode === 'clear'
  const [reason, setReason] = useState('')
  useEffect(() => { if (visible) setReason('') }, [visible])
  const canConfirm = clear || !requireReason || reason.trim().length > 0
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 justify-end bg-black/50">
        <Pressable className="flex-1" onPress={onClose} />
        <View className="bg-un1t-bg border-t border-un1t-border rounded-t-3xl p-5">
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-lg font-bold text-un1t-text">{clear ? "Clear, don't notify" : 'Decline'}</Text>
            <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={22} color="#94A3B8" /></Pressable>
          </View>
          <Text className="text-xs text-un1t-subtle mb-2">
            {clear ? 'Closes this request. The customer is sent nothing.' : requireReason ? 'A reason is required and is sent to the submitter.' : 'Add an optional note for the submitter.'}
          </Text>
          {clear && warn ? (
            <Text className="text-xs font-medium text-amber-700 mb-2">{CLEAR_WARNING}</Text>
          ) : null}
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder={clear ? 'Note (optional)…' : 'Reason…'}
            placeholderTextColor="#64748B"
            multiline
            maxLength={1000}
            style={{ minHeight: 80 }}
            className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text mb-4"
          />
          <Pressable onPress={() => onConfirm(reason.trim())} disabled={!canConfirm}
            className={`${clear ? 'bg-un1t-text' : 'bg-red-600'} active:opacity-80 disabled:opacity-40 px-4 py-3.5 rounded-xl items-center flex-row justify-center`}>
            <Ionicons name={clear ? 'remove-circle-outline' : 'close-circle'} size={18} color="#FFFFFF" />
            <Text className="text-base font-semibold text-white ml-2">{clear ? "Clear, don't notify" : 'Confirm decline'}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
