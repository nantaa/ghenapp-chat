import { useEffect } from 'react'
import { useAuthStore } from './stores/authStore'
import RegisterPage from './pages/RegisterPage'
import LoginPage from './pages/LoginPage'
import ChatPage from './pages/ChatPage'
import { registerServiceWorker, requestPushPermission, isPushSupported } from './push/push'
import './index.css'

// Minimal client-side routing based on pathname
function getPage(): 'register' | 'login' | 'chat' {
  const path = window.location.pathname
  if (path === '/register') return 'register'
  if (path === '/login') return 'login'
  return 'chat'
}

export default function App() {
  const { isAuthenticated } = useAuthStore()
  const page = getPage()

  // ── Auth guards ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isAuthenticated && page === 'chat') window.location.href = '/login'
    if (isAuthenticated && (page === 'login' || page === 'register')) window.location.href = '/'
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

  if (!isAuthenticated) {
    if (page === 'register') return <RegisterPage />
    return <LoginPage />
  }

  return <ChatPage />
}
