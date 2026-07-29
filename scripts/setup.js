// Single entry point for "make a fresh clone runnable" - coordinates the
// steps that used to be chained directly in package.json's "postinstall":
//
//   1. fetch-third-party.js     - download the Third-Party tools that have a stable release to pull from
//   2. fetch-hashes.js          - download hitman-hashes into extra/Third-Party (needs 7z.exe from
//                                  step 1 to already be there)
//
// Both land straight in extra/Third-Party - the embedded framework core's
// dev-mode toolsRoot (see src/main/paths.ts) - alongside the tools already
// committed there, so there's no separate build/ staging step to run first.
//
// Runs automatically via "npm install" (see "postinstall") if extra/Third-Party
// doesn't look populated yet, and can be re-run by hand at any time with
// `npm run setup` - e.g. to retry after a network hiccup or force a re-fetch.
// Both steps just warn on failure rather than throwing, so neither fails the
// "npm install" this runs from as part of postinstall (see fetch-third-party.js).
// Safe to re-run: both steps are themselves idempotent.
//
// Each step still runs as its own process (rather than being merged into
// one file) so `node scripts/fetch-third-party.js` etc. keep working
// unchanged as standalone scripts - this file just coordinates the order
// and gives package.json a single line to call instead of a growing &&
// chain.
import fs from "fs"
import path from "path"
import { execFileSync } from "child_process"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Only run on postinstall if extra/Third-Party already has more than the
// tools committed to git in it (a rough "has setup already run here" check -
// a fresh clone only has the committed subset).
const thirdPartyDir = path.join(__dirname, "..", "extra", "Third-Party")
const alreadyFetched = ["7z.exe", "HMLanguageTools.exe", "HMTextureTools.exe", "quickentity-rs.exe"].every((f) => fs.existsSync(path.join(thirdPartyDir, f)))

if (process.argv.includes("--postinstall") && alreadyFetched) {
	console.log("extra/Third-Party/ already looks populated, skipping postinstall setup. Run 'npm run setup' to force.")
	process.exit(0)
}

function run(...args) {
	execFileSync(process.execPath, args.map((a) => (a.endsWith(".js") ? path.join(__dirname, a) : a)), { stdio: "inherit" })
}

run("fetch-third-party.js")

try {
	run("fetch-hashes.js")
} catch (e) {
	console.warn(`Couldn't fetch hitman-hashes automatically (${e.message}). Re-run \`npm run setup\` later, or place them in "extra/Third-Party/" by hand.`)
}
