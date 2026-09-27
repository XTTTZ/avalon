import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.POKER_BASE_PATH || '/poker/',
  plugins: [react()],
  server: { port: 5174, strictPort: true, proxy: { '/api/poker': 'http://127.0.0.1:8788' } },
  preview: { port: 4174, proxy: { '/api/poker': 'http://127.0.0.1:8788' } },
  build: { target: 'es2020', sourcemap: false },
});
