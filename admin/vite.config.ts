import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  plugins: [react()],
  define: {
    // Single source of truth for the build version shown in the sidebar
    // and reported by the web player: package.json's "version".
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    proxy: {
      // Dev-only: forward API calls to the local server (npm run dev in server/)
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
