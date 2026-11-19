import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    strictPort: true,
    proxy: { '/api': {
      target: process.env.API_URL ?? 'http://localhost:8001',
      rewrite: (path) => path.replace(/^\/api/, ''),
      changeOrigin: true,
    } },
  },
});
