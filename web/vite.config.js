import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy the API in dev so the frontend always talks to a same-origin "/api",
    // exactly as it does in production (where Express serves this build). Keeps the
    // session cookie working and means no hardcoded backend host anywhere.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false },
    },
  },
});
