import adapter from "@sveltejs/adapter-static"
import preprocess from "svelte-preprocess"

/** @type {import("@sveltejs/kit").Config} */
const config = {
	kit: {
		adapter: adapter({
			pages: "out/renderer",
			assets: "out/renderer",
			fallback: "index.html"
		})
	},
	preprocess: preprocess({
		typescript: {
			transpileOnly: true
		}
	})
}

export default config
