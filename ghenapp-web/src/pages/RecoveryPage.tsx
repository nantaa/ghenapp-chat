import { useState } from 'react'
import { Shield, Loader2, Eye, EyeOff } from 'lucide-react'
import {
  generateIdentityKeyPair,
  generateSignedPrekey,
  generateOnetimePrekeys,
  mnemonicToSeed,
  storePrivateKey,
  storeSubKey,
  buildLoginMessage,
  signChallenge
} from '../crypto/keygen'
import * as api from '../lib/api'
import { useAuthStore } from '../stores/authStore'

export default function RecoveryPage() {
  const setUser = useAuthStore((s) => s.setUser)
  const [username, setUsername] = useState('')
  const [mnemonic, setMnemonic] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleRecover() {
    const uname = username.trim().toLowerCase()
    if (!uname) { setError('Username required.'); return }
    const words = mnemonic.trim().split(/\s+/)
    if (words.length !== 12) { setError('Mnemonic must be exactly 12 words.'); return }
    if (passphrase.length < 8) { setError('Passphrase must be at least 8 characters.'); return }
    
    setError('')
    setLoading(true)
    try {
      api.clearTokens()
      
      const seed = await mnemonicToSeed(words)
      const kp = await generateIdentityKeyPair(seed)

      // Login to verify key and get tokens
      const msg = buildLoginMessage(uname)
      const sig = await signChallenge(msg, kp.privateKey)
      const result = await api.login(uname, sig)
      api.setTokens(result.access_token, result.refresh_token)

      // Generate new prekeys to restore message receiving capability
      const signed = await generateSignedPrekey(kp.privateKey)
      await storeSubKey(`spk:${uname}`, signed.privateKey)
      
      const onetime = await generateOnetimePrekeys(10)
      for (let i = 0; i < onetime.privateKeys.length; i++) {
        await storeSubKey(`opk:${uname}:${i}`, onetime.privateKeys[i])
        const pubHex = Array.from(onetime.publicKeys[i]).map(b => b.toString(16).padStart(2, '0')).join('')
        await storeSubKey(`opk-pub:${uname}:${pubHex}`, onetime.privateKeys[i])
      }
      await api.uploadPrekeys(signed.publicKey, signed.signature, onetime.publicKeys)

      // Store identity key protected by new passphrase
      await storePrivateKey(uname, kp.privateKey, passphrase)

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
      setError(e.message ?? 'Recovery failed. Check your phrase and username.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <Shield size={20} style={{ display: 'inline', marginRight: 8, verticalAlign: 'middle' }} />
          Account Recovery
        </div>
        <p className="auth-subtitle">Restore your account using your 12-word recovery phrase.</p>

        <label className="auth-label">Username</label>
        <input
          className="input" placeholder="alice" value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />

        <label className="auth-label" style={{ marginTop: 12 }}>12-Word Recovery Phrase</label>
        <textarea
          className="input"
          placeholder="abandon ability able about above absent absorb abstract absurd abuse access accident"
          value={mnemonic}
          onChange={(e) => setMnemonic(e.target.value)}
          style={{ minHeight: 80, resize: 'vertical' }}
        />

        <label className="auth-label" style={{ marginTop: 12 }}>New Passphrase (to encrypt local keys)</label>
        <div style={{ position: 'relative' }}>
          <input
            className="input"
            type={showPass ? 'text' : 'password'}
            placeholder="Min. 8 characters"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            style={{ paddingRight: 40 }}
          />
          <button
            type="button"
            onClick={() => setShowPass((s) => !s)}
            style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
          >
            {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>

        {error && <p className="auth-error">{error}</p>}

        <button className="btn btn-primary" style={{ width: '100%', marginTop: 20 }} onClick={handleRecover} disabled={loading}>
          {loading ? <Loader2 size={16} className="spin" /> : 'Recover Account'}
        </button>

        <p style={{ textAlign: 'center', marginTop: 16, fontSize: 13, color: 'var(--text-muted)' }}>
          Remembered your password?{' '}
          <a href="/login" style={{ color: 'var(--accent)' }}>Sign in</a>
        </p>
      </div>
    </div>
  )
}
