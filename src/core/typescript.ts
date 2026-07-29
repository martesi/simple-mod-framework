import crypto from "crypto"
import fs from "fs-extra"
import os from "os"
import path from "path"

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

export interface CompileOptions {
	/** esbuild `target`, e.g. "es2019". Matches the JS syntax level the framework's own Node runtime supports. */
	target: string
}

/**
 * Compiles a mod's TypeScript file(s) and returns the absolute path to the
 * entry file (fileNames[0]) to require().
 *
 * Every fileName must resolve inside rootDir - manifests are mod-author
 * controlled, and without this check a `scripts` entry like
 * "../../../../somewhere" would let a mod read (and, before the fix above,
 * write) outside its own folder.
 *
 * Uses the native `esbuild` package (LEI-139) rather than `esbuild-wasm` or
 * the old `typescript` compiler. `esbuild-wasm` was tried first for its
 * cross-platform story, but that turned out to be a wash: this app only ever
 * ships for Windows (see electron-builder.yml's `win:` section), so there's
 * no multi-arch matrix being avoided, and the actual numbers favour native -
 * `esbuild` + `@esbuild/win32-x64` is ~11.3MB installed vs `esbuild-wasm`'s
 * ~13.8MB (the WASM blob has to encode a whole Go runtime on top of the
 * compiler itself). Native is also just the compiler running as machine code
 * instead of interpreted/JIT-compiled WASM - esbuild's own docs warn the WASM
 * build can be "in many cases... 10x slower". Both packages need identical
 * packaging treatment (see the IMPORTANT paragraph below), so there was no
 * packaging-complexity upside to WASM to weigh against any of that either.
 *
 * `esbuild` is `await import(...)`ed lazily, *inside* the cache-miss branch
 * below, rather than statically at the top of this file: on a cache hit (the
 * common case - most deploys re-run against unchanged mod scripts) the
 * module is never loaded at all, and even on a genuine cache miss the load
 * cost is only ever paid the first time a script actually needs compiling,
 * not on every process start. This mirrors the dynamic-import reasoning in
 * mod-manager-new/src/main/deployPipeline.ts, which was written for the same
 * reason against the old `typescript` package.
 *
 * IMPORTANT: `esbuild`'s own runtime code refuses to run at all if it
 * detects it's been bundled (it checks that `__filename`/`__dirname` still
 * point at its own unmodified `lib/main.js`, and throws "The esbuild
 * JavaScript API cannot be bundled" otherwise) - it must stay a real,
 * external `node_modules/esbuild` (plus `node_modules/@esbuild/win32-x64`,
 * where the actual binary lives) on disk in every consumer of this file, not
 * something a bundler is allowed to inline. See scripts/build.js's EXTERNAL
 * list for the CLI and mod-manager-new/electron.vite.config.ts +
 * electron-builder.yml for the embedded app.
 */
export async function compile(fileNames: string[], options: CompileOptions, rootDir: string): Promise<string> {
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
	const entryPath = path.join(destDir, path.relative(rootDir, fileNames[0]).replace(/\.tsx?$/, ".js"))

	if (fs.existsSync(entryPath)) {
		return entryPath // cache hit - this exact source (and these exact options) already compiled - esbuild never even gets loaded
	}

	// Not imported until we actually need to transpile something - see the doc comment above.
	const { transform } = await import("esbuild")

	for (const fileName of fileNames) {
		const relative = path.relative(rootDir, fileName).replace(/\.tsx?$/, ".js")
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			// Should be unreachable given the check above, but never write
			// outside destDir under any circumstances.
			throw new Error(`Refusing to write compiled output outside its cache folder: ${relative}`)
		}

		const ext = path.extname(fileName).toLowerCase()
		const loader = ext === ".tsx" ? "tsx" : ext === ".jsx" ? "jsx" : ext === ".js" ? "js" : "ts"

		// format: "cjs" plus esbuild's own ESM interop helpers (always injected
		// for cjs output, no separate flag needed) reproduces what
		// esModuleInterop did under ts.createProgram. `allowJs`/`resolveJsonModule`
		// have no equivalent here because there's no type-checker or module
		// resolver in the loop any more (there never was - see LEI-139) - a
		// mod script's own `import data from "./x.json"` downlevels to a plain
		// `require("./x.json")`, which Node already resolves natively.
		const result = await transform(fs.readFileSync(fileName, "utf8"), {
			loader,
			format: "cjs",
			target: options.target,
			sourcefile: fileName
		})

		const outPath = path.join(destDir, relative)
		fs.ensureDirSync(path.dirname(outPath))
		fs.writeFileSync(outPath, result.code)
	}

	return entryPath
}
