import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    strictPort: true,
    port: 5173,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  clearScreen: false,
});

