import { useState } from 'react'
import { Shield, Loader2, Copy, CheckCheck, Eye, EyeOff } from 'lucide-react'
import {
  generateIdentityKeyPair,
  generateSignedPrekey,
  generateOnetimePrekeys,
  generateMnemonic,
  mnemonicToSeed,
  storePrivateKey,
  storeSubKey,
} from '../crypto/keygen'
import { setIdentityKey } from '../ws/client'
import * as api from '../lib/api'
import { useAuthStore } from '../stores/authStore'

type Step = 'form' | 'mnemonic' | 'done'

function passphraseStrength(p: string): { score: number; label: string; color: string } {
  let score = 0
  if (p.length >= 10) score++
  if (p.length >= 16) score++
  if (/[A-Z]/.test(p)) score++
  if (/[0-9]/.test(p)) score++
  if (/[^A-Za-z0-9]/.test(p)) score++
  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong']
  const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#16a34a', '#15803d']
  return { score, label: labels[score] ?? 'Very weak', color: colors[score] ?? '#ef4444' }
}

export default function RegisterPage() {
  const setUser = useAuthStore((s) => s.setUser)
  const [username, setUsername] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [step, setStep] = useState<Step>('form')
  const [mnemonic, setMnemonic] = useState<string[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const strength = passphraseStrength(passphrase)

  async function handleGenerate() {
    if (username.trim().length < 3) { setError('Username must be at least 3 characters.'); return }
    if (passphrase.length < 8) { setError('Passphrase must be at least 8 characters.'); return }
    setError('')
    setLoading(true)
    try {
      api.clearTokens()
      const words = await generateMnemonic()
      const seed = await mnemonicToSeed(words)
      const kp = await generateIdentityKeyPair(seed)
      setMnemonic(words)
      ;(window as any).__ghen_kp = kp
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
      const uname = username.trim().toLowerCase()

      const result = await api.register(uname, kp.publicKey)
      api.setTokens(result.access_token, result.refresh_token)

      const signed = await generateSignedPrekey(kp.privateKey)
      // Store SPK and OPK as sub-keys (unencrypted — separate namespace)
      await storeSubKey(`spk:${uname}`, signed.privateKey)
      const onetime = await generateOnetimePrekeys(10)
      for (let i = 0; i < onetime.privateKeys.length; i++) {
        await storeSubKey(`opk:${uname}:${i}`, onetime.privateKeys[i])
        const pubHex = Array.from(onetime.publicKeys[i]).map(b => b.toString(16).padStart(2, '0')).join('')
        await storeSubKey(`opk-pub:${uname}:${pubHex}`, onetime.privateKeys[i])
      }
      await api.uploadPrekeys(signed.publicKey, signed.signature, onetime.publicKeys)

      // Persist identity key — AES-256-GCM encrypted with passphrase
      await storePrivateKey(uname, kp.privateKey, passphrase)
      // Cache the key in memory for immediate WS use (no passphrase re-entry needed)
      setIdentityKey(kp.privateKey)
      delete (window as any).__ghen_kp

      const profile = await api.getUser(uname)
      setUser({ id: profile.id, username: uname, displayName: null, publicKey: kp.publicKey, tier: 'free' })
      setTimeout(() => { window.location.href = '/' }, 50)
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
            <p className="auth-subtitle">Create your encrypted account. Your private key never leaves this device.</p>
            <label className="auth-label">Username</label>
            <input
              className="input" placeholder="alice" value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleGenerate()}
              autoFocus
            />
            <label className="auth-label" style={{ marginTop: 12 }}>Passphrase</label>
            <div style={{ position: 'relative' }}>
              <input
                className="input"
                type={showPass ? 'text' : 'password'}
                placeholder="Min. 8 characters — used to protect your key"
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
            {passphrase.length > 0 && (
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--surface-2)' }}>
                  <div style={{ width: `${(strength.score / 5) * 100}%`, height: '100%', borderRadius: 2, background: strength.color, transition: 'width 0.3s' }} />
                </div>
                <span style={{ fontSize: 11, color: strength.color }}>{strength.label}</span>
              </div>
            )}
            {error && <p className="auth-error">{error}</p>}
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 20 }} onClick={handleGenerate} disabled={loading}>
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
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ accentColor: 'var(--accent)', width: 16, height: 16 }} />
              I have saved my recovery phrase in a safe place.
            </label>
            {error && <p className="auth-error">{error}</p>}
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 16 }} onClick={handleRegister} disabled={!confirmed || loading}>
              {loading ? <Loader2 size={16} className="spin" /> : 'Create Account'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
