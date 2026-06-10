// MOB-UI.3 — DataTable primitive (RN). Responsive: columnar table on
// tablet, stacked label/value cards on phone. Same `columns` + `data`
// API both ways; the phone card lists each column as label: value.
// Mode + classes are unit-tested in ../../lib/ui-styles.js.
import { View, Text, Pressable, FlatList } from 'react-native'
import { useIsTablet } from '../../lib/use-is-tablet'
import {
  dataTableMode, tableHeaderClasses, tableRowClasses,
  tableHeaderTextClasses, tableCellTextClasses,
  dataCardClasses, dataCardLabelClasses, dataCardValueClasses,
} from '../../lib/ui-styles.js'

/**
 * @param {object} props
 * @param {{ key: string, label: string, flex?: number, render?: (row:object)=>React.ReactNode }[]} props.columns
 * @param {object[]} props.data
 * @param {(row:object)=>string} props.keyExtractor
 * @param {(row:object)=>void} [props.onRowPress]
 * @param {React.ReactNode} [props.empty]   rendered when data is empty
 */
export default function DataTable({ columns, data, keyExtractor, onRowPress, empty = null }) {
  const isTablet = useIsTablet()
  const mode = dataTableMode(isTablet)

  // Default cell text class differs by mode: table cells vs the value
  // side of a phone card (a custom col.render always wins).
  function cell(col, row, textClass = tableCellTextClasses()) {
    return col.render ? col.render(row) : <Text className={textClass}>{String(row[col.key] ?? '')}</Text>
  }

  if (mode === 'table') {
    return (
      <View>
        <View className={tableHeaderClasses()}>
          {columns.map(col => (
            <View key={col.key} style={{ flex: col.flex ?? 1 }}>
              <Text className={tableHeaderTextClasses()}>{col.label}</Text>
            </View>
          ))}
        </View>
        <FlatList
          data={data}
          keyExtractor={keyExtractor}
          ListEmptyComponent={empty}
          renderItem={({ item }) => {
            const cells = columns.map(col => (
              <View key={col.key} style={{ flex: col.flex ?? 1 }}>{cell(col, item)}</View>
            ))
            return onRowPress
              ? <Pressable className={tableRowClasses({ pressable: true })} onPress={() => onRowPress(item)}>{cells}</Pressable>
              : <View className={tableRowClasses({ pressable: false })}>{cells}</View>
          }}
        />
      </View>
    )
  }

  return (
    <FlatList
      data={data}
      keyExtractor={keyExtractor}
      ListEmptyComponent={empty}
      renderItem={({ item }) => {
        const body = columns.map(col => (
          <View key={col.key} className="mb-1 flex-row justify-between">
            <Text className={dataCardLabelClasses()}>{col.label}</Text>
            <View className="ml-2 flex-1 items-end">{cell(col, item, dataCardValueClasses())}</View>
          </View>
        ))
        return onRowPress
          ? <Pressable className={dataCardClasses()} onPress={() => onRowPress(item)}>{body}</Pressable>
          : <View className={dataCardClasses()}>{body}</View>
      }}
    />
  )
}
