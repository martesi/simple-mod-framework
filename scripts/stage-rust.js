// Copies the built native addon (see `npm run build:rust`) to where the
// TypeScript source and the pkg-compiled output expect to find it.
//
// Replaces the CI-only `copy ./rust/index.d.ts ./src/smf-rust.d.ts` etc.
// steps so the same thing works identically in CI and in a local build.
const fs = require("fs")
const path = require("path")

const root = path.join(__dirname, "..")
const mode = process.argv[2]

function findRustNode() {
	const rustDir = path.join(root, "rust")
	const match = fs.readdirSync(rustDir).find((f) => f.endsWith(".node"))
	if (!match) {
		throw new Error(`No .node file found in ${rustDir} - did \`npm run build:rust\` run first?`)
	}
	return path.join(rustDir, match)
}

if (mode === "src") {
	fs.copyFileSync(path.join(root, "rust", "index.d.ts"), path.join(root, "src", "smf-rust.d.ts"))
	fs.copyFileSync(findRustNode(), path.join(root, "src", "smf-rust.node"))
	console.log("Staged rust build output into src/")
} else if (mode === "compiled") {
	fs.copyFileSync(path.join(root, "src", "smf-rust.node"), path.join(root, "build", "compiled", "smf-rust.node"))
	console.log("Staged src/smf-rust.node into build/compiled/")
} else {
	console.error(`Usage: node scripts/stage-rust.js <src|compiled>`)
	process.exit(1)
}
