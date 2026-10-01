import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // The display is a Raspberry Pi 3 running Chromium 74, so newer syntax is
    // rewritten for it
    target: 'chrome74',
  },
  server: {
    // Forward API calls to the Express backend during development
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
