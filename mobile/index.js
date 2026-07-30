// Custom entry point (package.json "main").
//
// GEO-ATT — registers the geofence background task at true bundle-global
// scope so Android headless launches — which never mount ExpoRoot/app
// routes — still find it; see the expo-task-manager headless docs. The
// app/_layout.jsx import alone is not enough: a headless fire before the
// router tree loads would hit TaskManager's task-not-found path, which
// natively unregisters the geofencing task.
import './lib/geofence'
import 'expo-router/entry'
