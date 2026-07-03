import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev-only: forward API calls to the local server (npm run dev in server/)
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
