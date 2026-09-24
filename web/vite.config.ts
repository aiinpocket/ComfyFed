/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Python server serves the built SPA out of `web/dist`; in dev we proxy
// /api to the locally running ComfyFed server so cookies/CSRF behave the same.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8388',
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
