// Single entry point for "make a fresh clone runnable" - coordinates the
// steps that used to be chained directly in package.json's "postinstall":
//
//   1. fetch-third-party.js     - download the Third-Party tools that have a stable release to pull from
//   2. link-third-party.js      - link/seed everything build/Third-Party needs (the embedded framework
//                                  core's toolsRoot in dev - see mod-manager-new's src/main/paths.ts)
//   3. fetch-hashes.js build    - download hitman-hashes into build/Third-Party/ (needs 7z.exe from
//                                  step 2 to already be linked there)
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
