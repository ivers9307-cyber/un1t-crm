// CARDLENS-M.8 — the contact screen's studio switcher: one pill per studio
// this viewer can act at for the person, plus All studios (view only). The
// phone twin of the web ActingStudioBar. Decisions live in
// mobile/lib/contact-studio-lens.js; this only renders. Nothing for a viewer
// with one option; the footer line still says where sends and notes go.
import { View, Text, Pressable, ScrollView } from 'react-native'
import { ALL_STUDIOS, platformWord } from '../lib/contact-studio-lens'

function Pill({ label, sub, selected, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={sub ? `${label}, ${sub}` : label}
      className={`rounded-xl px-3 py-2 min-h-[44px] justify-center ${selected ? 'bg-un1t-accent' : 'bg-un1t-surface border border-un1t-border'}`}
    >
      <Text className={`text-sm font-semibold ${selected ? 'text-white' : 'text-un1t-text'}`}>{label}</Text>
      {sub ? <Text className={`text-[11px] ${selected ? 'text-white' : 'text-un1t-subtle'}`}>{sub}</Text> : null}
    </Pressable>
  )
}

/**
 * @param {object} props
 * @param {ReturnType<import('../lib/contact-studio-lens').lensView>} props.lens
 * @param {(studio: string) => void} props.onChange  a location id or 'all'
 */
export default function ContactStudioSwitcher({ lens, onChange }) {
  if (!lens?.hasLens) return null
  return (
    <View className="mt-4">
      {lens.showSwitcher && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} accessibilityRole="tablist">
          {lens.options.map((o) => (
            <Pill
              key={o.id}
              label={o.label}
              sub={[o.primary ? 'Primary' : null, platformWord(o.platform)].filter(Boolean).join(' · ') || null}
              selected={!lens.isAll && lens.actingId === o.id}
              onPress={() => onChange(o.id)}
            />
          ))}
          <Pill label="All studios" sub="View only" selected={lens.isAll} onPress={() => onChange(ALL_STUDIOS)} />
        </ScrollView>
      )}
      {lens.footer ? <Text className="text-xs text-un1t-subtle mt-2">{lens.footer}</Text> : null}
    </View>
  )
}
