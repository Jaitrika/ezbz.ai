import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'web',
  server: { host: '0.0.0.0', port: 3000, strictPort: true, proxy: { '/api': 'http://localhost:3001', '/health': 'http://localhost:3001' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
