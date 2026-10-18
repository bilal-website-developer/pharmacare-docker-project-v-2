import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envPrefix: ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'],
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
  },
});
