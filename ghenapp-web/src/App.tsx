import { useEffect } from 'react'
import { useAuthStore } from './stores/authStore'
import RegisterPage from './pages/RegisterPage'
import LoginPage from './pages/LoginPage'
import RecoveryPage from './pages/RecoveryPage'
import ChatPage from './pages/ChatPage'
import { registerServiceWorker, requestPushPermission, isPushSupported } from './push/push'
import './index.css'

// Minimal client-side routing based on pathname
function getPage(): 'register' | 'login' | 'recovery' | 'chat' {
  const path = window.location.pathname
  if (path === '/register') return 'register'
  if (path === '/recovery') return 'recovery'
  if (path === '/login') return 'login'
  return 'chat'
}

export default function App() {
  const { isAuthenticated } = useAuthStore()
  const page = getPage()

  // ── Auth guards ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isAuthenticated && page === 'chat') window.location.href = '/login'
    if (isAuthenticated && (page === 'login' || page === 'register' || page === 'recovery')) window.location.href = '/'
  }, [isAuthenticated, page])

  // ── Service Worker + Push subscription ───────────────────────────────────────
  useEffect(() => {
    if (!isPushSupported()) return
    // Always register the SW so it can handle push events even before user opts in
    registerServiceWorker().catch(console.warn)

    if (isAuthenticated) {
      const token = localStorage.getItem('ghen_access_token')
      if (token) {
        // Auto-request push permission once per session if not yet granted
        const alreadyAsked = localStorage.getItem('ghen_push_asked')
        if (!alreadyAsked && Notification.permission === 'default') {
          localStorage.setItem('ghen_push_asked', '1')
          // Small delay so it doesn't fire immediately on page load
          const tid = setTimeout(() => requestPushPermission(token), 3000)
          return () => clearTimeout(tid)
        }
      }
    }
  }, [isAuthenticated])

  if (!isAuthenticated || (page !== 'chat' && page !== 'register' && page !== 'login' && page !== 'recovery')) {
    if (page === 'register') return <RegisterPage />
    if (page === 'recovery') return <RecoveryPage />
    return <LoginPage />
  }

  // Even if authenticated, if we are on an auth sub-page (due to a race condition or direct link), 
  // don't show the ChatPage (which starts WS) until the redirect in useEffect finishes.
  if (page !== 'chat') return <div className="auth-loading">Redirecting...</div>

  return <ChatPage />
}
