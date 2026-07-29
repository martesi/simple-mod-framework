// Sets up build/Third-Party/ - the embedded framework core's dev-mode
// `toolsRoot` (see src/main/paths.ts: packaged builds get
// their tools via electron-builder.yml's extraResources instead, landing at
// process.resourcesPath; this script mirrors that same layout under build/
// for `npm run dev`):
//
//   - build/Third-Party/<file>       <- link to  "For Build/Third-Party/<file>"
//                                        or       "For Build/Fetched Third-Party/<file>"
//     (this links whatever is in either folder. "For Build/Third-Party/" is
//     committed to the repo as regular git blobs (this repo is managed with
//     jj, which doesn't support Git LFS - see .gitignore) for tools with no
//     stable place to download them from. "For Build/Fetched Third-Party/"
//     is gitignored and populated by `scripts/fetch-third-party.js` (runs
//     automatically via postinstall) for tools that DO have a stable
//     release to pull from, so there's no point duplicating them in git
//     history. Either way nothing gets placed in build/Third-Party/
//     directly: build/ is gitignored and safe to delete at any time (e.g.
//     `rm -rf build` to force a clean rebuild), so anything with no other
//     copy would be lost for good if it lived there)
//   - build/cleanMicrosoftThumbs.dat   <- link to  "For Build/cleanMicrosoftThumbs.dat"
//     (mirrors the cleanMicrosoftThumbs.dat/cleanPackageDefinition.txt/cleanThumbs.dat
//     entries in electron-builder.yml's extraResources - gameDetect.ts reads this one
//     back out of toolsRoot at runtime; the other two are generated fresh from the
//     user's own game install by deploy.ts instead, so they don't need linking here)
//
// Runs automatically via scripts/setup.js (called by the root "postinstall"
// script), and is safe to re-run - it clears and recreates the linked files
// each time so they can't go stale (e.g. a dangling link left over from a
// previous machine/environment).
//
// Prefers symlinks (kept in sync with the source automatically) but falls
// back to copying if link creation fails - e.g. on Windows without Developer
// Mode or admin rights, `fs.symlinkSync` throws EPERM for file links.
const fs = require("fs")
const path = require("path")

const root = path.join(__dirname, "..")
const buildDir = path.join(root, "build")
const forBuild = path.join(root, "For Build")

fs.mkdirSync(buildDir, { recursive: true })

function link(destPath, srcPath, type) {
	fs.mkdirSync(path.dirname(destPath), { recursive: true })
	fs.rmSync(destPath, { recursive: true, force: true }) // clears real files/dirs *and* dangling links

	try {
		fs.symlinkSync(path.relative(path.dirname(destPath), srcPath), destPath, type)
		return "linked"
	} catch {
		fs.cpSync(srcPath, destPath, { recursive: true })
		return "copied"
	}
}

// --- build/Third-Party/ ---

const thirdPartyDest = path.join(buildDir, "Third-Party")
fs.mkdirSync(thirdPartyDest, { recursive: true })

const expectedThirdPartyFiles = new Set()

for (const thirdPartySrc of [path.join(forBuild, "Third-Party"), path.join(forBuild, "Fetched Third-Party")]) {
	if (!fs.existsSync(thirdPartySrc)) continue

	for (const file of fs.readdirSync(thirdPartySrc)) {
		expectedThirdPartyFiles.add(file)
		const how = link(path.join(thirdPartyDest, file), path.join(thirdPartySrc, file), "file")
		console.log(`build/Third-Party/${file}: ${how} from ${path.relative(root, thirdPartySrc)}/${file}`)
	}
}

// Prune anything left over from a file that used to come from one of the two
// source folders above but no longer does (e.g. a file that moved from
// For Build/Third-Party/ to For Build/Fetched Third-Party/, like this repo
// just did) - otherwise it lingers as a stale link/copy that nothing
// refreshes.
for (const file of fs.readdirSync(thirdPartyDest)) {
	if (!expectedThirdPartyFiles.has(file)) {
		fs.rmSync(path.join(thirdPartyDest, file), { recursive: true, force: true })
		console.log(`build/Third-Party/${file}: removed (no longer in For Build/Third-Party/ or For Build/Fetched Third-Party/)`)
	}
}

// --- build/cleanMicrosoftThumbs.dat ---

console.log(`build/cleanMicrosoftThumbs.dat: ${link(path.join(buildDir, "cleanMicrosoftThumbs.dat"), path.join(forBuild, "cleanMicrosoftThumbs.dat"), "file")} from For Build/cleanMicrosoftThumbs.dat`)

console.log("build/Third-Party/ ready.")
