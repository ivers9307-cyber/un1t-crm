// Reason sheet for declining an approval. `requireReason` (expenses + invoices)
// disables Confirm until non-empty; optional for time-off/swaps.
import { useState, useEffect } from 'react'
import { View, Text, Pressable, Modal, TextInput, KeyboardAvoidingView, Platform } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

export default function DeclineSheet({ visible, requireReason, onConfirm, onClose }) {
  const [reason, setReason] = useState('')
  useEffect(() => { if (visible) setReason('') }, [visible])
  const canConfirm = !requireReason || reason.trim().length > 0
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 justify-end bg-black/50">
        <Pressable className="flex-1" onPress={onClose} />
        <View className="bg-un1t-bg border-t border-un1t-border rounded-t-3xl p-5">
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-lg font-bold text-un1t-text">Decline</Text>
            <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={22} color="#94A3B8" /></Pressable>
          </View>
          <Text className="text-xs text-un1t-subtle mb-2">
            {requireReason ? 'A reason is required and is sent to the submitter.' : 'Add an optional note for the submitter.'}
          </Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="Reason…"
            placeholderTextColor="#64748B"
            multiline
            maxLength={1000}
            style={{ minHeight: 80 }}
            className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text mb-4"
          />
          <Pressable onPress={() => onConfirm(reason.trim())} disabled={!canConfirm}
            className="bg-red-600 active:opacity-80 disabled:opacity-40 px-4 py-3.5 rounded-xl items-center flex-row justify-center">
            <Ionicons name="close-circle" size={18} color="#FFFFFF" />
            <Text className="text-base font-semibold text-white ml-2">Confirm decline</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
