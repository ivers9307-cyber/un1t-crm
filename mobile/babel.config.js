module.exports = function (api) {
  api.cache(true)
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    plugins: [
      // Reanimated's babel plugin moved into react-native-worklets in v4. MUST be last.
      'react-native-worklets/plugin',
    ],
  }
}
