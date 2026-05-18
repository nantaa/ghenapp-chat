// GhenApp API client — centralized HTTP layer with auto auth token management

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'

import { useAuthStore } from '../stores/authStore'

class APIError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'APIError'
  }
}

function getAccessToken(): string | null {
  return localStorage.getItem('ghen_access_token')
}

export function setTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem('ghen_access_token', accessToken)
  localStorage.setItem('ghen_refresh_token', refreshToken)
}

export function clearTokens() {
  localStorage.removeItem('ghen_access_token')
  localStorage.removeItem('ghen_refresh_token')
}

async function tryRefresh(): Promise<boolean> {
  const rt = localStorage.getItem('ghen_refresh_token')
  if (!rt) return false
  try {
    const res = await fetch(`${BASE_URL}/api/v1/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    })
    if (!res.ok) return false
    const data = await res.json()
    setTokens(data.access_token, data.refresh_token)
    return true
  } catch {
    return false
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  const token = getAccessToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers })

  if (res.status === 401 && retry) {
    const refreshed = await tryRefresh()
    if (refreshed) return request<T>(path, options, false)
    clearTokens()
    useAuthStore.getState().clearUser()
    setTimeout(() => {
      window.location.href = '/login'
    }, 50)
    throw new APIError(401, '401 Unauthorized (Session expired)')
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    const msg = body.error || res.statusText || 'Unknown error'
    throw new APIError(res.status, `${res.status} ${msg}`.trim())
  }

  return res.json() as Promise<T>
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export function register(username: string, publicKey: Uint8Array) {
  return request<{ access_token: string; refresh_token: string }>('/api/v1/register', {
    method: 'POST',
    body: JSON.stringify({ username, public_key: Array.from(publicKey) }),
  })
}

export function login(username: string, signature: Uint8Array) {
  return request<{ access_token: string; refresh_token: string }>('/api/v1/login', {
    method: 'POST',
    body: JSON.stringify({ username, signature: Array.from(signature) }),
  })
}

export function logout(refreshToken: string) {
  return request('/api/v1/logout', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
}

// ─── Users ────────────────────────────────────────────────────────────────────

export function getUser(username: string) {
  return request<{
    id: string; username: string; display_name: string | null
    public_key: number[]; key_version: number; discoverable: boolean
  }>(`/api/v1/users/${encodeURIComponent(username)}`)
}

export function updateProfile(displayName: string, discoverable: boolean) {
  return request('/api/v1/users/me', {
    method: 'PUT',
    body: JSON.stringify({ display_name: displayName, discoverable }),
  })
}

// ─── Prekeys ──────────────────────────────────────────────────────────────────

export function uploadPrekeys(
  signedPrekey: Uint8Array,
  signature: Uint8Array,
  onetimePrekeys: Uint8Array[],
) {
  return request('/api/v1/prekeys', {
    method: 'POST',
    body: JSON.stringify({
      signed_prekey: Array.from(signedPrekey),
      signature: Array.from(signature),
      onetime_prekeys: onetimePrekeys.map((k) => Array.from(k)),
    }),
  })
}

export function getPrekeys(username: string) {
  return request<{
    user_id: string; username: string
    public_key: number[]; key_version: number
    signed_prekey: { public_key: number[]; signature: number[] }
    onetime_prekey?: { public_key: number[] }
  }>(`/api/v1/prekeys/${encodeURIComponent(username)}`)
}

export function createDM(targetUserId: string) {
  return request<{ conversation_id: string }>('/api/v1/dm', {
    method: 'POST',
    body: JSON.stringify({ target_user_id: targetUserId }),
  })
}

// Bug #6 fix: REST endpoints for conversation list + message history
export function getConversations() {
  return request<{
    conversations: Array<{
      id: string
      type: string
      members: Array<{ user_id: string; username: string }>
    }>
  }>('/api/v1/conversations')
}

export function getMessages(conversationId: string) {
  return request<{
    messages: Array<{
      id: number
      conversation_id: string
      sender_id: string
      payload: number[]
      msg_type: string
      timestamp_ms: number
      delivered: boolean
    }>
  }>(`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`)
}

export function getE2ESession(conversationId: string) {
  return request<{
    conversation_id: string
    sender_id: string
    sender_ik_pub: string
    sender_ek_pub: string
    opk_pub: string | null
  }>(`/api/v1/dm/${encodeURIComponent(conversationId)}/session`)
}


// ─── Groups ───────────────────────────────────────────────────────────────────

export function createGroup(name: string) {
  return request<{ id: string; conversation_id: string; name: string }>('/api/v1/groups', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export function getGroup(id: string) {
  return request<{ group: { id: string; name: string }; members: { user_id: string; role: string }[] }>(
    `/api/v1/groups/${id}`,
  )
}

export function addGroupMember(groupId: string, userId: string) {
  return request(`/api/v1/groups/${groupId}/members`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  })
}

export function createInvite(groupId: string, expiresInHours: number, maxUses: number) {
  return request<{ token: string; expires_at: string; max_uses: number }>(
    `/api/v1/groups/${groupId}/invite`,
    { method: 'POST', body: JSON.stringify({ expires_in_hours: expiresInHours, max_uses: maxUses }) },
  )
}

export function joinViaInvite(token: string) {
  return request<{ message: string; group_id: string }>(`/api/v1/invite/${token}/join`, { method: 'POST' })
}

// ─── Uploads ──────────────────────────────────────────────────────────────────

export async function uploadFile(file: File): Promise<{ id: string; url: string; mime_type: string }> {
  const token = getAccessToken()
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE_URL}/api/v1/upload`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new APIError(res.status, body.error)
  }
  return res.json()
}
