import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

/**
 * The web client is served from the same origin as the API: the reverse proxy
 * (TLS 1.3) maps /api/* to the NestJS API without the prefix, and /api/ws to
 * the Socket.io endpoint. The dev server does the same.
 */
const API = process.env.PUET_API_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Workspace packages are compiled from source (they publish CommonJS for Node).
    alias: { '@puet/shared': pkg('shared'), '@puet/signing': pkg('signing'), '@puet/e2ee': pkg('e2ee') },
  },
  optimizeDeps: { exclude: ['@matrix-org/matrix-sdk-crypto-wasm'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api/ws': { target: API, ws: true, rewrite: (p) => p.replace(/^\/api/, '') },
      '/api': { target: API, changeOrigin: false, rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
  },
});
