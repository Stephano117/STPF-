import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    // En développement, l'API tourne sur :8787 ; même origine vue du navigateur.
    proxy: { '/api': 'http://localhost:8787', '/health': 'http://localhost:8787' },
  },
  build: { sourcemap: false, target: 'es2022' },
  test: { environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 120_000 },
});
