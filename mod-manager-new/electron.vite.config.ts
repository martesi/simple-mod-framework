import { resolve } from "node:path"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"

// This app is designed to eventually replace the Mod Manager's Electron
// renderer (see LEI-137). It's still UI only: the main/preload processes
// here are intentionally minimal stubs (just enough to open a window and
// load the renderer) - the real fs/child_process-off-the-renderer work
// lands in LEI-134, and embedded-core/game-directory wiring in LEI-133.
// Everything in the renderer talks to the mocked contract in
// src/renderer/src/lib/ipc.ts instead of window.fs/window.ipc.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src")
      }
    },
    plugins: [react()]
  }
})
