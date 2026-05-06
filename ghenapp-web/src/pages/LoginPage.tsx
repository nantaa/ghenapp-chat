import { useState } from 'react'
import { Shield, Loader2 } from 'lucide-react'
import { buildLoginMessage, signChallenge, loadPrivateKey, storePrivateKey } from '../crypto/keygen'
import * as api from '../lib/api'
import { useAuthStore } from '../stores/authStore'

export default function LoginPage() {
  const setUser = useAuthStore((s) => s.setUser)
  const [username, setUsername] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleLogin() {
    if (!username.trim()) { setError('Username required.'); return }
    setError('')
    setLoading(true)
    try {
      // Always normalise to lowercase — the server stores usernames lowercased
      // (strings.ToLower). The IndexedDB key and the challenge message must
      // both use the same casing or signature verification will fail.
      const uname = username.trim().toLowerCase()

      let privKey = await loadPrivateKey(uname)

      // Migration: keys registered before the lowercase fix may be stored
      // under the original typed casing. Try that as a fallback and
      // re-save under the normalised key so future logins work.
      if (!privKey && uname !== username.trim()) {
        const legacyKey = await loadPrivateKey(username.trim())
        if (legacyKey) {
          await storePrivateKey(uname, legacyKey)
          privKey = legacyKey
        }
      }

      if (!privKey) {
        setError('No local key found for this username. Did you register on this device?')
        return
      }
      const msg = buildLoginMessage(uname)
      const sig = await signChallenge(msg, privKey)
      const result = await api.login(uname, sig)
      api.setTokens(result.access_token, result.refresh_token)

      // Fetch profile
      const profile = await api.getUser(uname)
      setUser({
        id: profile.id,
        username: profile.username,
        displayName: profile.display_name,
        publicKey: new Uint8Array(profile.public_key),
        tier: 'free',
      })
      // Delay navigation slightly to allow Zustand's persist middleware
      // to asynchronously write the new state to sessionStorage.
      setTimeout(() => {
        window.location.href = '/'
      }, 50)
    } catch (e: any) {
      setError(e.message ?? 'Login failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <Shield size={20} style={{ display: 'inline', marginRight: 8, verticalAlign: 'middle' }} />
          GhenApp
        </div>
        <p className="auth-subtitle">
          Sign in with your Ed25519 key stored on this device.
        </p>

        <label className="auth-label">Username</label>
        <input
          className="input"
          placeholder="alice"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          autoFocus
        />

        {error && <p className="auth-error">{error}</p>}

        <button
          className="btn btn-primary"
          style={{ width: '100%', marginTop: 20 }}
          onClick={handleLogin}
          disabled={loading}
        >
          {loading ? <Loader2 size={16} className="spin" /> : 'Sign In'}
        </button>

        <p style={{ textAlign: 'center', marginTop: 16, fontSize: 13, color: 'var(--text-muted)' }}>
          Don&apos;t have an account?{' '}
          <a href="/register" style={{ color: 'var(--accent)' }}>Create one</a>
        </p>
      </div>
    </div>
  )
}
