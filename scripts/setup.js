// Single entry point for "make a fresh clone runnable" - coordinates the
// steps that used to be chained directly in package.json's "postinstall":
//
//   1. fetch-third-party.js     - download the Third-Party tools that have a stable release to pull from
//   2. link-third-party.js      - link/seed everything build/ needs to look like an unpacked dist/
//   3. fetch-hashes.js build    - download hitman-hashes into build/Third-Party/ (needs 7z.exe from
//                                  step 2 to already be linked there) - the CLI needs these to actually
//                                  run/deploy locally, not just in a packaged release (see "assemble:win"
//                                  for the dist/Third-Party equivalent used there)
//
// (piscina used to need a manual staging step here too, because it was
// vendored in ./piscina instead of being a normal npm dependency. It's now
// just "piscina" in package.json's dependencies like everything else - see
// deploy.ts for why the vendoring/patch existed and why it's no longer
// needed.)
//
// Runs automatically via "npm install" (see "postinstall") if no build/
// directory is present, and can be re-run by hand at any time with
// `npm run setup` - e.g. to retry after a network hiccup or force a setup
// even if build/ exists (steps 1 and 3 both just warn on failure rather
// than throwing, so neither fails the "npm install" this runs from as part
// of postinstall - see fetch-third-party.js). Safe to re-run: all steps
// are themselves idempotent.
//
// Each step still runs as its own process (rather than being merged into
// one file) so `node scripts/fetch-third-party.js` etc. keep working
// unchanged as standalone scripts - this file just coordinates the order
// and gives package.json a single line to call instead of a growing &&
// chain.
const fs = require("fs")
const path = require("path")
const { execFileSync } = require("child_process")

// Only run on postinstall if the build directory doesn't exist
if (process.argv.includes("--postinstall") && fs.existsSync(path.join(__dirname, "..", "build"))) {
	console.log("build/ directory already exists, skipping postinstall setup. Run 'npm run setup' to force.")
	process.exit(0)
}

function run(...args) {
	execFileSync(process.execPath, args.map((a) => (a.endsWith(".js") ? path.join(__dirname, a) : a)), { stdio: "inherit" })
}

run("fetch-third-party.js")
run("link-third-party.js")

try {
	run("fetch-hashes.js", "build")
} catch (e) {
	console.warn(`Couldn't fetch hitman-hashes automatically (${e.message}). Re-run \`npm run setup\` later, or place them in "build/Third-Party/" by hand.`)
}

// Patch piscina's worker.js to support loading from pkg's virtual filesystem
try {
	const piscinaWorkerPath = path.join(__dirname, "..", "node_modules", "piscina", "dist", "worker.js")
	if (fs.existsSync(piscinaWorkerPath)) {
		let workerContent = fs.readFileSync(piscinaWorkerPath, "utf8")
		const targetStr = 'handler = await Promise.resolve(`${filename}`).then(s => __importStar(require(s)));'
		if (workerContent.includes(targetStr)) {
			const replacementStr = `let target = filename;
		if (typeof process.pkg !== 'undefined') {
			const path = require('path');
			target = path.join(__dirname, "../../../build/compiled", path.basename(filename));
		}
		handler = await Promise.resolve(\`\${target}\`).then(s => __importStar(require(s)));`
			workerContent = workerContent.replace(targetStr, replacementStr)
			fs.writeFileSync(piscinaWorkerPath, workerContent, "utf8")
			console.log("Successfully patched piscina worker path resolution for pkg compatibility.")
		} else if (workerContent.includes("process.pkg")) {
			console.log("Piscina worker already patched.")
		} else {
			console.warn("Could not find target require statement in piscina worker.js for patching.")
		}
	} else {
		console.warn("Piscina worker.js not found at expected path: " + piscinaWorkerPath)
	}
} catch (e) {
	console.warn("Failed to patch piscina worker: " + e.message)
}

