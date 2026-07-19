// Sets up everything `compiled/main.js` needs to run - build/ is the actual
// working directory you `cd` into to run it (same idea as dist/: config.json,
// Third-Party/, Mods/, etc. all live next to the entry point), so build/ ends
// up looking like an unpacked dist/ - minus the Mod Manager frontend, which
// still needs its own `npm run build` in "Mod Manager/":
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
//   - build/Info                     <- link to  docs/
//   - build/cleanThumbs.dat            <- link to  "For Build/cleanThumbs.dat"
//   - build/cleanMicrosoftThumbs.dat   <- link to  "For Build/cleanMicrosoftThumbs.dat"
//   - build/cleanPackageDefinition.txt <- link to  "For Build/cleanPackageDefinition.txt"
//   - build/Mods                     <- one-time COPY (not a link!) of "For Build/Mods",
//     seeded only if build/Mods doesn't already exist
//   - build/config.json              <- one-time COPY (not a link!) of "For Build/config.json",
//     seeded only if build/config.json doesn't already exist
//
// Mods/ and config.json are deliberately copied rather than linked - both get
// written to at runtime (mod caches/load order, and config edits/autosave
// respectively), and linking them would mean local state gets written
// straight into the tracked "For Build/" source tree.
//
// Runs automatically via the root "postinstall" script, and is safe to
// re-run - it clears and recreates the linked files/folders each time so
// they can't go stale (e.g. a dangling link left over from a previous
// machine/environment), but never touches an existing Mods/ or config.json.
//
// Prefers symlinks (kept in sync with the source automatically) but falls
// back to copying if link creation fails - e.g. on Windows without Developer
// Mode or admin rights, `fs.symlinkSync` throws EPERM for file links.
// Directory links use "junction" instead, which Windows allows without
// elevation (the "type" argument is a Windows-only concept - POSIX ignores
// it and just makes a normal symlink either way).
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

function seed(destPath, srcPath) {
	if (!fs.existsSync(destPath)) {
		fs.mkdirSync(path.dirname(destPath), { recursive: true })
		fs.cpSync(srcPath, destPath, { recursive: true })
		return "seeded"
	}
	return "already exists, left as-is"
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

// --- build/Info/ (docs) ---

console.log(`build/Info/: ${link(path.join(buildDir, "Info"), path.join(root, "docs"), "junction")} from docs/`)

// --- build/cleanThumbs.dat, cleanMicrosoftThumbs.dat, cleanPackageDefinition.txt ---

for (const file of ["cleanThumbs.dat", "cleanMicrosoftThumbs.dat", "cleanPackageDefinition.txt"]) {
	console.log(`build/${file}: ${link(path.join(buildDir, file), path.join(forBuild, file), "file")} from For Build/${file}`)
}

// --- build/Mods/ ---

console.log(`build/Mods/: ${seed(path.join(buildDir, "Mods"), path.join(forBuild, "Mods"))}`)

// --- build/config.json ---

console.log(`build/config.json: ${seed(path.join(buildDir, "config.json"), path.join(forBuild, "config.json"))}`)

console.log("build/ now looks like an unpacked dist/ (minus the Mod Manager frontend) - cd into it to run compiled/main.js.")
