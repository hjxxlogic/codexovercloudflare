import { defineConfig } from 'vite';
export default defineConfig({
  root: 'apps/web',
  base: './',
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
