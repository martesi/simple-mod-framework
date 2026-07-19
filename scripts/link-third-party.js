// Merges `For Build/Third-Party/` (rpkg-cli.exe, ResourceTool.exe + its
// ResourceLib_*.dll, assimp.dll, quickentity_ffi.dll, hash_list.hmla) into the
// root `Third-Party/` folder, which is the one `src/rpkg.ts`, `src/deploy.ts`,
// and `src/patchWorker.ts` actually read from at runtime (via
// `path.join(process.cwd(), "Third-Party", ...)`).
//
// Today those two folders are separate because `assemble-dist.js` merges them
// only when building the packaged dist/. Running `compiled/main.js` straight
// from the repo root (no packaging) needs the merge to already exist on disk -
// this script does that merge in-place, once, so local dev runs actually work.
//
// Always copies rather than symlinking: a symlink created through a cross-OS/
// networked mount (e.g. a sandbox with the repo mounted from the host) can
// silently produce an NTFS reparse point the host's native Windows can't
// resolve ("Unsupported reparse point type"), and unlike a normal failed
// symlink attempt, that failure mode doesn't throw - it only surfaces later
// when something tries to read the link. Copying a few tens of MB once is a
// small price for not risking that.
const fs = require("fs")
const path = require("path")

const root = path.join(__dirname, "..")
const src = path.join(root, "For Build", "Third-Party")
const dest = path.join(root, "Third-Party")

fs.mkdirSync(dest, { recursive: true })

for (const file of fs.readdirSync(src)) {
	const srcPath = path.join(src, file)
	const destPath = path.join(dest, file)

	if (fs.existsSync(destPath)) {
		continue // Already copied from a previous run.
	}

	fs.copyFileSync(srcPath, destPath)
	console.log(`Copied Third-Party/${file}`)
}

console.log("Third-Party/ now has everything deploy needs to run from the repo root.")
