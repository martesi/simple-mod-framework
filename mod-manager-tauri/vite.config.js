import { sveltekit } from "@sveltejs/kit/vite"
import { defineConfig } from "vite"

const host = process.env.TAURI_DEV_HOST

/** @type {import('vite').UserConfig} */
export default defineConfig({
	plugins: [sveltekit()],
	clearScreen: false,
	server: {
		port: 5173,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: "ws",
					host,
					port: 5183
				}
			: undefined,
		watch: {
			ignored: ["**/src-tauri/**"]
		}
	}
})
