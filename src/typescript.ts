import crypto from "crypto"
import fs from "fs-extra"
import os from "os"
import path from "path"
import ts from "typescript"

// Compiled mod scripts used to land in `<cwd>/compiled` and get wiped after
// every use (fs.removeSync). Two problems with that:
//
// 1. Collision: `<cwd>/compiled` is also where the framework's own tsc
//    output can live (e.g. when running the dev build with build/ as cwd).
//    A mod script named e.g. "core.ts" or "main.ts" would get compiled
//    straight on top of the framework's own core.js/main.js - the write is
//    keyed off the *mod-supplied* filename, so a mod controls where its
//    output lands relative to whatever else happens to be in that
//    directory. Worse, the code explicitly evicted that path from
//    require.cache, so a later legitimate require() of "core" would read
//    back the mod's script instead of the framework's own module.
// 2. No caching: every discovery pass and every deploy re-transpiled from
//    scratch even when the script hadn't changed, then deleted the result.
//
// Fixed by moving entirely out of the framework's own directories (system
// temp, not cwd) and making the cache content-addressed: the destination is
// a hash of the source content (and compiler options), never the mod's own
// filenames, so a mod cannot choose where its compiled output is written,
// and unchanged sources are never recompiled. Because the destination
// changes whenever the content does, there's nothing to evict from
// require.cache - a stale hash is simply never requested again.
const cacheRoot = path.join(os.tmpdir(), "simple-mod-framework", "script-cache")
const maxCacheAgeMs = 30 * 24 * 60 * 60 * 1000 // 30 days

let pruned = false
function pruneOldCacheEntriesOnce() {
	if (pruned) return
	pruned = true

	try {
		const now = Date.now()
		for (const entry of fs.readdirSync(cacheRoot)) {
			const entryPath = path.join(cacheRoot, entry)
			const stat = fs.statSync(entryPath)
			if (now - stat.mtimeMs > maxCacheAgeMs) {
				fs.removeSync(entryPath)
			}
		}
	} catch {
		// Best-effort only - a permission error or missing cacheRoot here
		// should never break compilation.
	}
}

/**
 * Compiles a mod's TypeScript file(s) and returns the absolute path to the
 * entry file (fileNames[0]) to require().
 *
 * Every fileName must resolve inside rootDir - manifests are mod-author
 * controlled, and without this check a `scripts` entry like
 * "../../../../somewhere" would let a mod read (and, before the fix above,
 * write) outside its own folder.
 */
export function compile(fileNames: string[], options: ts.CompilerOptions, rootDir: string): string {
	for (const fileName of fileNames) {
		const relative = path.relative(rootDir, fileName)
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`Refusing to compile a script that escapes its mod folder: ${fileName}`)
		}
	}

	fs.ensureDirSync(cacheRoot)
	pruneOldCacheEntriesOnce()

	const hash = crypto.createHash("sha256")
	hash.update(JSON.stringify(options))
	for (const fileName of fileNames) {
		hash.update(path.relative(rootDir, fileName))
		hash.update(fs.readFileSync(fileName))
	}
	const key = hash.digest("hex")

	const destDir = path.join(cacheRoot, key)
	const entryPath = path.join(destDir, path.relative(rootDir, fileNames[0]).replace(/\.ts$/, ".js"))

	if (fs.existsSync(entryPath)) {
		return entryPath // cache hit - this exact source (and these exact options) already compiled
	}

	const program = ts.createProgram(fileNames, options)
	program.emit(undefined, (filename, data) => {
		const relative = path.relative(rootDir, filename)
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			// Should be unreachable given the check above, but never write
			// outside destDir under any circumstances.
			throw new Error(`Refusing to write compiled output outside its cache folder: ${relative}`)
		}

		const outPath = path.join(destDir, relative)
		fs.ensureDirSync(path.dirname(outPath))
		fs.writeFileSync(outPath, data)
	})

	return entryPath
}
