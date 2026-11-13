// Offline support: cache the app files; use the network first so updates arrive.
const CACHE = 'rakaat-v2';
const FILES = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'keepawake.mp4', 'lib/face-api.js',
  'models/tiny_face_detector_model-weights_manifest.json', 'models/tiny_face_detector_model.bin',
  'icons/icon-192.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});
