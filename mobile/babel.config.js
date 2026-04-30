module.exports = function (api) {
  api.cache(true)
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    plugins: [
      // Required by react-native-reanimated. MUST be last.
      'react-native-reanimated/plugin',
    ],
  }
}
