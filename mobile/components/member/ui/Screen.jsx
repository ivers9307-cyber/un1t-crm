import { ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
export default function Screen({ children }) {
  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left','right']}>
      <ScrollView contentContainerClassName="p-5 pb-24">{children}</ScrollView>
    </SafeAreaView>
  )
}
