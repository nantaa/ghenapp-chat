// GhenApp Service Worker
// Handles Web Push notifications and offline caching.
//
// Registration: navigator.serviceWorker.register('/sw.js')
// Push payload expected JSON: { title, body, icon, tag, url }

const CACHE_NAME = 'ghenapp-v2'
const PRECACHE = ['/', '/index.html']

// ─── Install ─────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  )
})

// ─── Activate ────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys
        .filter((k) => k !== CACHE_NAME)
        .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  )
})

// ─── Fetch (cache-first for precached assets) ─────────────────────────────────
self.addEventListener('fetch', (event) => {
  // Only cache GET requests for same-origin
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  if (url.origin !== location.origin) return

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached
      return fetch(event.request).then((resp) => {
        // Cache successful HTML/JS/CSS responses
        if (resp.ok && (resp.url.endsWith('.js') || resp.url.endsWith('.css') || resp.url.endsWith('.html'))) {
          const clone = resp.clone()
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone))
        }
        return resp
      }).catch(() => caches.match('/index.html')) // offline fallback
    })
  )
})

// ─── Push event ──────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = { title: 'GhenApp', body: 'You have a new message', icon: '/icon-192.png', tag: 'ghen-msg', url: '/' }
  if (event.data) {
    try { data = { ...data, ...event.data.json() } } catch { /* use defaults */ }
  }

  const opts = {
    body: data.body,
    icon: data.icon,
    badge: '/icon-96.png',
    tag: data.tag,           // collapses: replaces any prior notification with same tag
    renotify: false,
    data: { url: data.url },
    actions: [
      { action: 'open',    title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  }

  event.waitUntil(
    self.registration.showNotification(data.title, opts)
  )
})

// ─── Notification click ───────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  if (event.action === 'dismiss') return

  const targetUrl = event.notification.data?.url ?? '/'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus existing open tab if available
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          client.focus()
          return
        }
      }
      // Open a new tab
      if (clients.openWindow) {
        return clients.openWindow(targetUrl)
      }
    })
  )
})

// ─── Push subscription change ─────────────────────────────────────────────────
self.addEventListener('pushsubscriptionchange', (event) => {
  // Re-subscribe automatically when subscription expires
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: event.oldSubscription?.options?.applicationServerKey,
    }).then((sub) => {
      // Inform the app to re-register with the server
      self.clients.matchAll().then((clients) => {
        clients.forEach((c) => c.postMessage({ type: 'PUSH_RESUBSCRIBED', subscription: sub.toJSON() }))
      })
    }).catch(() => { /* subscription may have been revoked */ })
  )
})
