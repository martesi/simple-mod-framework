import { resolve } from "node:path"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"

// This app replaces the old Svelte Mod Manager's Electron renderer (see
// LEI-137 for the UI rebuild). fs/child_process access lives only in
// src/main (LEI-134) - the renderer talks to it exclusively through the
// SmfApi contract in src/renderer/src/lib/ipc.ts, backed by preload's
// contextBridge-exposed `smf` object (never a raw window.fs/window.ipc).
// Embedded-core/game-directory-picker wiring (replacing the Deploy.exe
// subprocess spawn with the in-process framework core) is LEI-133.
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
