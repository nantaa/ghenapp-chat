// Zustand auth store — user identity, JWT session state
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { AuthUser } from '../types'

interface AuthState {
  user: AuthUser | null
  isAuthenticated: boolean
  setUser: (user: AuthUser) => void
  clearUser: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isAuthenticated: false,
      setUser: (user) => set({ user, isAuthenticated: true }),
      clearUser: () => set({ user: null, isAuthenticated: false }),
    }),
    {
      name: 'ghen-auth',
      storage: createJSONStorage(() => sessionStorage),
      // Never persist the raw publicKey bytes — re-load from crypto store on boot
      partialize: (state) => ({
        user: state.user
          ? { ...state.user, publicKey: [] }
          : null,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
)
