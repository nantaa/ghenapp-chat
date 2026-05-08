import { useState } from 'react'
import { Shield, Loader2, Copy, CheckCheck } from 'lucide-react'
import {
  generateIdentityKeyPair,
  generateSignedPrekey,
  generateOnetimePrekeys,
  deriveMnemonic,
  storePrivateKey,
} from '../crypto/keygen'
import * as api from '../lib/api'
import { useAuthStore } from '../stores/authStore'

type Step = 'form' | 'mnemonic' | 'done'

export default function RegisterPage() {
  const setUser = useAuthStore((s) => s.setUser)
  const [username, setUsername] = useState('')
  const [step, setStep] = useState<Step>('form')
  const [mnemonic, setMnemonic] = useState<string[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  async function handleGenerate() {
    if (username.trim().length < 3) {
      setError('Username must be at least 3 characters.')
      return
    }
    setError('')
    setLoading(true)
    try {
      // Clear any stale session from a previous attempt before registering
      api.clearTokens()
      const kp = await generateIdentityKeyPair()
      const words = await deriveMnemonic(kp.privateKey)
      setMnemonic(words)
        // Cache keypair in closure for next step
        ; (window as any).__ghen_kp = kp
      setStep('mnemonic')
    } catch (e: any) {
      setError(e.message ?? 'Key generation failed.')
    } finally {
      setLoading(false)
    }
  }

  async function handleRegister() {
    setError('')
    setLoading(true)
    try {
      const kp = (window as any).__ghen_kp
      // Normalise to lowercase — must match what the server stores and what
      // LoginPage will look up in IndexedDB after a logout/login cycle.
      const uname = username.trim().toLowerCase()

      const result = await api.register(uname, kp.publicKey)

      // ⚠ Set tokens FIRST — uploadPrekeys requires a valid Bearer token
      api.setTokens(result.access_token, result.refresh_token)

      // Upload prekeys for X3DH session initiation
      const signed = await generateSignedPrekey(kp.privateKey)
      await storePrivateKey(`spk:${username}`, signed.privateKey)
      const onetime = await generateOnetimePrekeys(10)
      await api.uploadPrekeys(signed.publicKey, signed.signature, onetime)

      // Persist private key to IndexedDB BEFORE clearing the temp keypair
      await storePrivateKey(uname, kp.privateKey)
      delete (window as any).__ghen_kp

      setUser({
        id: '',
        username: uname,
        displayName: null,
        publicKey: kp.publicKey,
        tier: 'free',
      })

      // Redirect to chat — App.tsx auth guard will route to ChatPage
      // Delay navigation slightly so Zustand persist can save state
      setTimeout(() => {
        window.location.href = '/'
      }, 50)
    } catch (e: any) {
      setError(e.message ?? 'Registration failed.')
    } finally {
      setLoading(false)
    }
  }

  function copyMnemonic() {
    navigator.clipboard.writeText(mnemonic.join(' '))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <Shield size={20} style={{ display: 'inline', marginRight: 8, verticalAlign: 'middle' }} />
          GhenApp
        </div>

        {step === 'form' && (
          <>
            <p className="auth-subtitle">
              Create your encrypted account. Your private key never leaves this device.
            </p>
            <label className="auth-label">Username</label>
            <input
              className="input"
              placeholder="alice"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleGenerate()}
              autoFocus
            />
            {error && <p className="auth-error">{error}</p>}
            <button
              className="btn btn-primary"
              style={{ width: '100%', marginTop: 20 }}
              onClick={handleGenerate}
              disabled={loading}
            >
              {loading ? <Loader2 size={16} className="spin" /> : 'Generate Keys & Continue'}
            </button>
            <p style={{ textAlign: 'center', marginTop: 16, fontSize: 13, color: 'var(--text-muted)' }}>
              Already have an account?{' '}
              <a href="/login" style={{ color: 'var(--accent)' }}>Sign in</a>
            </p>
          </>
        )}

        {step === 'mnemonic' && (
          <>
            <p className="auth-subtitle">
              🔐 Save your 12-word recovery phrase. This is the <strong>only way</strong> to recover your account.
            </p>
            <div className="auth-mnemonic">
              {mnemonic.map((word, i) => (
                <div key={i} className="auth-mnemonic-word">
                  <span>{i + 1}.</span>
                  <span>{word}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={copyMnemonic}>
                {copied ? <CheckCheck size={14} /> : <Copy size={14} />}
                {copied ? 'Copied!' : 'Copy phrase'}
              </button>
            </div>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer', fontSize: 13, color: 'var(--text-muted)' }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                style={{ accentColor: 'var(--accent)', width: 16, height: 16 }}
              />
              I have saved my recovery phrase in a safe place.
            </label>
            {error && <p className="auth-error">{error}</p>}
            <button
              className="btn btn-primary"
              style={{ width: '100%', marginTop: 16 }}
              onClick={handleRegister}
              disabled={!confirmed || loading}
            >
              {loading ? <Loader2 size={16} className="spin" /> : 'Create Account'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
