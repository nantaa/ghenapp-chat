import { useState } from 'react'
import { Shield, Loader2 } from 'lucide-react'
import { buildLoginMessage, signChallenge, loadPrivateKey } from '../crypto/keygen'
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
      const privKey = await loadPrivateKey(username.trim())
      if (!privKey) {
        setError('No local key found for this username. Did you register on this device?')
        return
      }
      const msg = buildLoginMessage(username.trim())
      const sig = await signChallenge(msg, privKey)
      const result = await api.login(username.trim(), sig)
      api.setTokens(result.access_token, result.refresh_token)

      // Fetch profile
      const profile = await api.getUser(username.trim())
      setUser({
        id: profile.id,
        username: profile.username,
        displayName: profile.display_name,
        publicKey: new Uint8Array(profile.public_key),
        tier: 'free',
      })
      window.location.href = '/'
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
