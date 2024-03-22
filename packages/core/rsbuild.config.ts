import { defineConfig } from "@rsbuild/core"
import { resolve } from "node:path"

export default defineConfig({
	output: {
		targets: ["node"],
		externals: ["sweetalert2", "electron", "electron-json-storage",'./three-onlymath.min.js'],
		distPath: { server: "/" },
		sourceMap: { js: "source-map" }
	},
	source: {
		entry: { main: "./src/main.ts" }
	}
})
