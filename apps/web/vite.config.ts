import { defineConfig } from 'vite';
export default defineConfig({
  root: 'apps/web',
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
