// Single entry point for "make a fresh clone runnable" - coordinates the
// steps that used to be chained directly in package.json's "postinstall":
//
//   0. node_modules/electron/install.js - download the actual Electron binary for this
//                                          platform (see the doc comment right above that
//                                          call below for why this has to be done explicitly)
//   1. fetch-third-party.js     - download the Third-Party tools that have a stable release to pull from
//   2. fetch-hashes.js          - download hitman-hashes into extra/Third-Party (needs 7z.exe from
//                                  step 1 to already be there)
//
// Steps 1 and 2 land straight in extra/Third-Party - the embedded framework core's
// dev-mode toolsRoot (see src/main/paths.ts) - alongside the tools already
// committed there, so there's no separate build/ staging step to run first.
//
// Runs automatically via "npm install"/"bun install" (see "postinstall"). Step 0 always
// runs (it's cheap to skip-check, see below); steps 1-2 skip themselves if extra/Third-Party
// doesn't look populated yet. Can be re-run by hand at any time with `npm run setup` - e.g.
// to retry after a network hiccup or force a re-fetch. All three steps just warn on failure
// rather than throwing, so none of them fail the "npm install"/"bun install" this runs from
// as part of postinstall (see fetch-third-party.js). Safe to re-run: all three are themselves
// idempotent.
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

// Electron's own package no longer declares a "postinstall" script (electron@43.1.1's
// package.json has an empty "scripts": {} - it only exposes an "install-electron" bin
// pointing at this same install.js) - older electron versions had a real postinstall that
// npm ran automatically as part of installing the "electron" dependency, no project-side
// wiring needed. Even if it still did, bun wouldn't run it automatically anyway: bun only
// executes lifecycle scripts (preinstall/install/postinstall) for dependencies explicitly
// listed in a "trustedDependencies" array (or bun's own small default allowlist), as a
// supply-chain-attack mitigation, and this project doesn't have such a list. So nothing has
// ever triggered Electron's own binary download automatically since this project moved to
// bun (`git log` shows scripts/setup.js/its predecessors never called this either, even
// pre-bun) - `electron-vite dev`/`build` would fail with "Electron uninstall" without it.
// Calling it here works around both problems at once: this is the *project's own*
// postinstall script (not a dependency's), so bun's trustedDependencies gate doesn't apply
// to it at all - and install.js has its own `isInstalled()` early-exit (checks for the
// platform binary already being present), so this is safe and cheap to call unconditionally
// on every postinstall run rather than needing our own populated-check like steps 1-2 below.
const electronInstallScript = path.join(__dirname, "..", "node_modules", "electron", "install.js")
if (fs.existsSync(electronInstallScript)) {
	try {
		execFileSync(process.execPath, [electronInstallScript], { stdio: "inherit" })
	} catch (e) {
		console.warn(`Couldn't download the Electron binary automatically (${e.message}). Re-run \`npm run setup\` later, or run \`node node_modules/electron/install.js\` (or \`bun run install-electron\`) by hand.`)
	}
} else {
	console.warn('"electron" not found in node_modules - skipping its binary download. Run `npm install`/`bun install` first.')
}

// Only run steps 1-2 on postinstall if every setup-time artifact is present. A fresh clone has
// none of the release-backed tools below because they are intentionally ignored rather than
// duplicated in git history.
const thirdPartyDir = path.join(__dirname, "..", "extra", "Third-Party")
const alreadyFetched = [
	"7z.exe",
	"HMLanguageTools.exe",
	"HMTextureTools.exe",
	"quickentity-3.exe",
	"quickentity-rs.exe",
	"rpkg-cli.exe",
	"quickentity_ffi.dll",
	"assimp.dll",
	"hash_list.hmla",
	"hash_list.txt",
	"ResourceTool.exe",
	"ResourceLib_HM2.dll",
	"ResourceLib_HM2016.dll",
	"ResourceLib_HM3.dll",
	"xdelta3.exe"
].every((f) => fs.existsSync(path.join(thirdPartyDir, f)))

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
