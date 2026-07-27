import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "node:path"

// This app is designed to eventually be dropped in as the Mod Manager's
// renderer (see LEI-137). It's built standalone for now so the UI isn't
// blocked on the fs/child_process-off-the-renderer work in LEI-134 or the
// embedded-core wiring in LEI-133 - everything talks to the mocked contract
// in src/lib/ipc.ts instead of window.fs/window.ipc directly.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  server: {
    port: 5273
  }
})
