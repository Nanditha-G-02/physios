import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Development: `npm run dev` serves the UI on :5173 and forwards the API, dataset files,
// camera streams and the ROS WebSocket to a running PHYSIOS gateway (default :8700).
const gateway = process.env.PHYSIOS_GATEWAY || 'http://127.0.0.1:8700';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: gateway },
      '/ros': { target: gateway.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
  test: { environment: 'jsdom', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
} as any);
