// Push notification manager — handles service worker registration,
// VAPID subscription, and server subscription sync.

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'

// ─── Types ────────────────────────────────────────────────────────────────────

export type PushStatus = 'unsupported' | 'denied' | 'granted' | 'default'

export interface PushManagerState {
  supported: boolean
  permission: PushStatus
  subscribed: boolean
}

// ─── Feature detection ────────────────────────────────────────────────────────

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

// ─── Service Worker Registration ──────────────────────────────────────────────

let _swReg: ServiceWorkerRegistration | null = null

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null
  try {
    _swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
    console.log('[push] service worker registered')

    // Handle re-subscriptions when SW tells us subscription changed
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (ev.data?.type === 'PUSH_RESUBSCRIBED') {
        const token = sessionStorage.getItem('ghen_access_token')
        if (token && ev.data.subscription) {
          _syncSubscription(ev.data.subscription, token).catch(console.warn)
        }
      }
    })

    return _swReg
  } catch (err) {
    console.warn('[push] SW registration failed:', err)
    return null
  }
}

// ─── Permission & Subscription ────────────────────────────────────────────────

/** Request push permission and subscribe; posts subscription to server. */
export async function requestPushPermission(accessToken: string): Promise<boolean> {
  if (!isPushSupported()) return false

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    console.log('[push] permission denied:', permission)
    return false
  }

  try {
    const reg = _swReg ?? await registerServiceWorker()
    if (!reg) return false

    // Fetch server VAPID public key
    const vapidKey = await fetchVAPIDKey()
    if (!vapidKey) return false

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    })

    await _syncSubscription(sub.toJSON(), accessToken)
    console.log('[push] subscribed and synced with server')
    return true
  } catch (err) {
    console.warn('[push] subscription failed:', err)
    return false
  }
}

/** Unsubscribe from push notifications and remove from server. */
export async function unsubscribePush(accessToken: string): Promise<void> {
  if (!_swReg) return
  try {
    const sub = await _swReg.pushManager.getSubscription()
    if (!sub) return
    const endpoint = sub.endpoint
    await sub.unsubscribe()
    await _removeSubscription(endpoint, accessToken)
    console.log('[push] unsubscribed')
  } catch (err) {
    console.warn('[push] unsubscribe failed:', err)
  }
}

/** Returns current push subscription state. */
export async function getPushState(): Promise<PushManagerState> {
  if (!isPushSupported()) return { supported: false, permission: 'unsupported', subscribed: false }
  const permission = Notification.permission as PushStatus
  const reg = _swReg ?? await registerServiceWorker()
  const sub = reg ? await reg.pushManager.getSubscription() : null
  return { supported: true, permission, subscribed: !!sub }
}

// ─── Server sync ──────────────────────────────────────────────────────────────

async function fetchVAPIDKey(): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/push/vapid-key`)
    if (!res.ok) return null
    const data = await res.json()
    return data.public_key ?? null
  } catch {
    return null
  }
}

async function _syncSubscription(sub: ReturnType<PushSubscription['toJSON']>, token: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/v1/push/subscribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(sub),
  })
  if (!res.ok) throw new Error(`push sync failed: ${res.status}`)
}

async function _removeSubscription(endpoint: string, token: string): Promise<void> {
  await fetch(`${API_URL}/api/v1/push/subscribe`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ endpoint }),
  })
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Convert a URL-safe base64 VAPID key to a Uint8Array for pushManager.subscribe() */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}
