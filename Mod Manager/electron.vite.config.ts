import { defineConfig } from 'electron-vite'
import { sveltekit } from '@sveltejs/kit/vite'

export default defineConfig({
  main: {},
  preload: {
    build: {
      externalizeDeps: { include: ['original-fs'] }
    }
  },
  renderer: {
    plugins: [sveltekit()]
  }
})
