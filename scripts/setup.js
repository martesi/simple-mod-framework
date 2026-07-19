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
// Runs automatically via "npm install" (see "postinstall"), and can be
// re-run by hand at any time with `npm run setup` - e.g. to retry after a
// network hiccup (steps 1 and 3 both just warn on failure rather than
// throwing, so neither fails the "npm install" this runs from as part of
// postinstall - see fetch-third-party.js). Safe to re-run: all steps are
// themselves idempotent.
//
// Each step still runs as its own process (rather than being merged into
// one file) so `node scripts/fetch-third-party.js` etc. keep working
// unchanged as standalone scripts - this file just coordinates the order
// and gives package.json a single line to call instead of a growing &&
// chain.
const path = require("path")
const { execFileSync } = require("child_process")

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
