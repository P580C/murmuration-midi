import { defineConfig } from 'vite';

// Fixed port so it doesn't collide with other local Vite projects on 5173.
export default defineConfig({
  server: { port: 5190, open: true },
  preview: { port: 5191 },
});
