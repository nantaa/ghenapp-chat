import { useState } from 'react'
import { Shield, Loader2, Eye, EyeOff } from 'lucide-react'
import { buildLoginMessage, signChallenge, loadPrivateKey, isKeyEncrypted, storePrivateKey } from '../crypto/keygen'
import * as api from '../lib/api'
import { useAuthStore } from '../stores/authStore'

export default function LoginPage() {
  const setUser = useAuthStore((s) => s.setUser)
  const [username, setUsername] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [needsPassphrase, setNeedsPassphrase] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleLogin() {
    if (!username.trim()) { setError('Username required.'); return }
    setError('')
    setLoading(true)
    try {
      const uname = username.trim().toLowerCase()

      // Check if the stored key is passphrase-protected
      const encrypted = await isKeyEncrypted(uname)
      if (encrypted && !needsPassphrase) {
        setNeedsPassphrase(true)
        setLoading(false)
        return
      }

      let privKey = await loadPrivateKey(uname, encrypted ? passphrase : undefined)

      // Migration: keys registered before lowercase fix
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

      const profile = await api.getUser(uname)
      setUser({
        id: profile.id,
        username: profile.username,
        displayName: profile.display_name,
        publicKey: new Uint8Array(profile.public_key),
        tier: 'free',
      })
      setTimeout(() => { window.location.href = '/' }, 50)
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
        <p className="auth-subtitle">Sign in with your Ed25519 key stored on this device.</p>

        <label className="auth-label">Username</label>
        <input
          className="input" placeholder="alice" value={username}
          onChange={(e) => { setUsername(e.target.value); setNeedsPassphrase(false) }}
          onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          autoFocus
        />

        {needsPassphrase && (
          <>
            <label className="auth-label" style={{ marginTop: 12 }}>Passphrase</label>
            <div style={{ position: 'relative' }}>
              <input
                className="input"
                type={showPass ? 'text' : 'password'}
                placeholder="Enter your passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                style={{ paddingRight: 40 }}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPass((s) => !s)}
                style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
              >
                {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </>
        )}

        {error && <p className="auth-error">{error}</p>}

        <button className="btn btn-primary" style={{ width: '100%', marginTop: 20 }} onClick={handleLogin} disabled={loading}>
          {loading ? <Loader2 size={16} className="spin" /> : (needsPassphrase ? 'Unlock & Sign In' : 'Sign In')}
        </button>

        <p style={{ textAlign: 'center', marginTop: 16, fontSize: 13, color: 'var(--text-muted)' }}>
          Don&apos;t have an account?{' '}
          <a href="/register" style={{ color: 'var(--accent)' }}>Create one</a>
          <br />
          <span style={{ display: 'inline-block', marginTop: 8 }}>
            Lost your key?{' '}
            <a href="/recovery" style={{ color: 'var(--accent)' }}>Recover account</a>
          </span>
        </p>
      </div>
    </div>
  )
}
