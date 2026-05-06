import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  build: {
    // Silence the 500 kB warning — we deliberately split below that
    chunkSizeWarningLimit: 600,

    rollupOptions: {
      output: {
        // Split vendor chunks so browsers can cache them independently
        manualChunks(id) {
          // libsodium-wrappers is ~480 kB (WASM + JS glue) — its own chunk
          if (id.includes('libsodium-wrappers')) {
            return 'vendor-sodium'
          }
          // React + ReactDOM — rarely changes, long cache lifetime
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react'
          }
          // Lucide icons — large icon set, rarely changes
          if (id.includes('lucide-react')) {
            return 'vendor-icons'
          }
          // Zustand + idb + flatbuffers — small but stable
          if (
            id.includes('node_modules/zustand') ||
            id.includes('node_modules/idb') ||
            id.includes('node_modules/flatbuffers')
          ) {
            return 'vendor-utils'
          }
        },
      },
    },
  },
})
