import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist-web', emptyOutDir: true },
  server: {},
  test: { environment: 'jsdom' },
})
