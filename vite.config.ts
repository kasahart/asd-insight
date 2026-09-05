import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { fileURLToPath, URL } from 'node:url';
// The main UI never gets JavaScript eval. Pyodide dynamic linking is isolated
// by the audio worker response's own policy, matching the deployment template.
const pageCsp =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self'; media-src 'self' blob: data:; connect-src 'self'; font-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";
const audioCsp =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; worker-src 'none'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";
export default defineConfig({
  base: './',
  publicDir: './runtime/prepared',
  plugins: [
    react(),
    {
      name: 'production-preview-security-headers',
      configurePreviewServer(server) {
        server.middlewares.use((request, response, next) => {
          const audioWorker =
            /\/assets\/audio\.worker-[A-Za-z0-9_-]+\.js$/.test(
              (request.url ?? '').split('?')[0],
            );
          response.setHeader(
            'Content-Security-Policy',
            audioWorker ? audioCsp : pageCsp,
          );
          response.setHeader('X-Content-Type-Options', 'nosniff');
          response.setHeader('Referrer-Policy', 'no-referrer');
          response.setHeader(
            'Permissions-Policy',
            'microphone=(), camera=(), geolocation=()',
          );
          next();
        });
      },
    },
  ],
  css: { postcss: { plugins: [tailwindcss()] } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@domain': fileURLToPath(new URL('./packages/domain', import.meta.url)),
      '@storage': fileURLToPath(
        new URL('./packages/browser-storage', import.meta.url),
      ),
      '@audio': fileURLToPath(
        new URL('./packages/audio-runtime', import.meta.url),
      ),
      '@contracts': fileURLToPath(
        new URL('./packages/contracts', import.meta.url),
      ),
    },
  },
  server: { host: '127.0.0.1', strictPort: true },
  build: { target: 'es2022' },
});
