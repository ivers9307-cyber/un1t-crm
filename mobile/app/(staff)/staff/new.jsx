// STAFF-C3 wizard — create a new staff member from mobile. Owner (at the
// active location) or master only, matching POST /api/staff. Collects
// name + email + employment type + role and creates the member with a
// single initial assignment at the CALLER'S ACTIVE LOCATION (the common
// onboarding case; multi-location is added afterwards via the role
// editor / web). The server invites them by email (Supabase magic link →
// /reset-password); the admin never handles a password.
import { useState } from 'react'
import { View, Text, ScrollView, Pressable } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { z } from 'zod'
import { useAuth } from '../../../lib/auth-context'
import { sdk } from '../../../lib/sdk'
import { Form, FormField, Button } from '../../../components/ui'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

const EMPLOYMENT = [{ key: 'fte', label: 'Full-time' }, { key: 'contractor', label: 'Contractor' }]
// Per-location roles the create route accepts (no 'master' — that's the
// is_master platform flag, granted on web only). The server re-validates
// against the caller's allowed roles + owned locations.
const ROLES = [
  { key: 'staff', label: 'Staff' },
  { key: 'reception', label: 'Reception' },
  { key: 'head_coach', label: 'Head Coach' },
  { key: 'manager', label: 'Manager' },
  { key: 'owner', label: 'Owner' },
]

const CreateSchema = z.object({
  full_name: z.string().min(1, 'Name is required').max(200),
  email: z.string().min(1, 'Email is required').email('Enter a valid email'),
  employment_type: z.enum(['fte', 'contractor']),
  role: z.enum(['owner', 'manager', 'head_coach', 'staff']),
})

function Segmented({ options, value, onChange }) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {options.map(opt => {
        const active = value === opt.key
        return (
          <Pressable
            key={opt.key}
            onPress={() => onChange(opt.key)}
            className={`rounded-xl px-3 py-2 items-center ${active ? 'bg-un1t-accent' : 'bg-un1t-surface border border-un1t-border'}`}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text className={`text-sm font-medium ${active ? 'text-white' : 'text-un1t-subtle'}`}>{opt.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export default function StaffNew() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  // Mirrors the POST /api/staff gate: owner at the active location, or a
  // platform master. (profile.role is the active-location role.)
  const canCreate = !!profile && (profile.isMaster || profile.role === 'owner')

  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  async function save(values) {
    if (!activeLocation?.id) {
      setError('No active studio selected — switch to a studio first.')
      return
    }
    setSaving(true)
    setError(null)
    const res = await sdk.staff.create({
      email: values.email.trim(),
      full_name: values.full_name.trim(),
      employment_type: values.employment_type,
      assignments: [{ location_id: activeLocation.id, role: values.role, is_default: true }],
    })
    setSaving(false)
    if (!res.success) {
      // The route returns a clean message for the common 409 (email
      // already registered) — surface it verbatim.
      setError(res.error || 'Could not create staff member')
      return
    }
    const newId = res.data?.id
    if (newId) router.replace(`/staff/${newId}`)
    else router.back()
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'New staff', headerLeft: () => <BackHeaderLeft label="Staff" fallbackHref="/staff" /> }} />

      {!canCreate ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">
            Creating staff requires owner or master access.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerClassName="px-4 pt-4 pb-10">
          {error && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
              <Text className="text-red-500 text-sm">{error}</Text>
            </View>
          )}

          <View className="bg-un1t-surface border border-un1t-border rounded-xl p-3 mb-4">
            <Text className="text-xs text-un1t-subtle">
              New staff at <Text className="text-un1t-text font-semibold">{activeLocation?.name || 'your studio'}</Text>. They’ll get an email invite to set their own password.
            </Text>
          </View>

          <Form
            initialValues={{ full_name: '', email: '', employment_type: 'fte', role: 'staff' }}
            schema={CreateSchema}
            onSubmit={save}
          >
            {({ submit }) => (
              <>
                <FormField name="full_name" label="Full name" required inputProps={{ placeholder: 'Jane Doe', autoCapitalize: 'words' }} />

                <FormField
                  name="email"
                  label="Email"
                  required
                  inputProps={{ placeholder: 'name@example.com', keyboardType: 'email-address', autoCapitalize: 'none', autoCorrect: false }}
                />

                <FormField name="employment_type" label="Employment">
                  {({ value, onChange }) => (
                    <Segmented options={EMPLOYMENT} value={value} onChange={onChange} />
                  )}
                </FormField>

                <FormField name="role" label={`Role at ${activeLocation?.name || 'this studio'}`}>
                  {({ value, onChange }) => (
                    <Segmented options={ROLES} value={value} onChange={onChange} />
                  )}
                </FormField>

                <View className="mt-6">
                  <Button
                    label={saving ? 'Creating…' : 'Create & send invite'}
                    onPress={submit}
                    disabled={saving || !activeLocation?.id}
                    loading={saving}
                  />
                </View>
              </>
            )}
          </Form>
        </ScrollView>
      )}
    </View>
  )
}
