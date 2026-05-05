# GhenApp Web Client

## Environment Variables

Create `ghenapp-web/.env.local`:
```
VITE_API_URL=http://localhost:8080
VITE_WS_URL=ws://localhost:8080
```

## Dev Server

```bash
cd ghenapp-web
npm run dev
# Opens at http://localhost:5173
```

## Pages

| Route | Description |
|---|---|
| `/register` | Create account — Ed25519 keygen + mnemonic phrase |
| `/login` | Sign in — signs server challenge with local key |
| `/` | Chat — real-time IMCP messaging via WebSocket |

## Architecture

```
src/
├── crypto/keygen.ts     Ed25519 keygen, signing, IndexedDB storage
├── ws/client.ts         WebSocket + IMCP binary frame encode/decode
├── lib/api.ts           HTTP API client, auto JWT refresh
├── stores/
│   ├── authStore.ts     Zustand auth state (sessionStorage)
│   └── chatStore.ts     Zustand chat state (in-memory)
├── pages/
│   ├── RegisterPage.tsx
│   ├── LoginPage.tsx
│   └── ChatPage.tsx
└── types/index.ts       Shared TypeScript types
```
