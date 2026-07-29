// Builds the root CLI: type-checks with the project's pinned `typescript`
// devDependency (leniently - see below), then bundles with `bun build`.
//
// This replaces the old two-step "tsc-lenient.js emits JS, pkg snapshots
// node_modules as-is" pipeline. `bun build` is used here purely as a fast
// TS-aware bundler (it does no type-checking of its own - that's still tsc's
// job, run first). The main reason to bundle at all is `three`: the CLI only
// uses THREE.Matrix4/Euler/MathUtils (see main.ts/patchWorker.ts), but
// without tree-shaking, `pkg` would snapshot the *entire* three package
// (tens of MB, incl. renderers/loaders/examples this project never touches)
// into the exe - same problem the old hand-vendored src/three-onlymath.min.js
// had, just via a real dependency instead of a vendored blob.
//
// Everything else stays external (plain `require(...)` in the output,
// resolved from node_modules at runtime exactly like before) rather than
// being bundled in, because several of these packages depend on their own
// on-disk layout in ways bundling would break:
//   - hash-wasm / hdr-histogram-js load WASM binaries from disk.
//   - @sentry/* patches node internals / does its own dynamic requires.
//   - esbuild is used at runtime (src/typescript.ts's `transform()` call,
//     used to compile mod authors' script files - see LEI-139, and see that
//     file's doc comment for why native `esbuild` was picked over
//     `esbuild-wasm`) and, unlike the packages above, *must* stay external
//     rather than merely benefiting from it: esbuild's own runtime code
//     checks that __filename/__dirname still point at its unmodified
//     lib/main.js and throws "The esbuild JavaScript API cannot be bundled"
//     if a bundler has inlined it. It still needs to be a real, unmodified
//     node_modules/esbuild *and* node_modules/@esbuild/win32-x64 (the actual
//     binary) on disk next to the built exe for @yao-pkg/pkg's own
//     snapshotting - see that build's own asset-copying step (mirroring the
//     existing Third-Party/7z.exe handling, since esbuild spawns a subprocess
//     pointed at a real file path, which won't resolve to anything from
//     inside a pkg snapshot).
// `three` and `crc` are also deliberately kept out of package.json's
// "dependencies" (they're devDependencies instead), even though bun build
// needs them present in node_modules at build time. That's not just style -
// @yao-pkg/pkg's walker unconditionally snapshots every package listed in
// the *root* package.json's "dependencies", regardless of whether the
// compiled output actually require()s it (see lib-es5/walker.js,
// stepActivate - it's the "can't prove what a private entry package might
// dynamically load" fallback; --public opts out of it, but the default
// doesn't). Since three/crc are fully inlined into main.js/patchWorker.js by
// the time pkg runs, leaving them in "dependencies" would make pkg snapshot
// the *entire* three package on top of the already-inlined copy - it cost
// ~30MB in the exe the one time this shipped that way. devDependencies
// aren't read by that walker at all, so keep them there.
//
// None of that applies to `three` or `crc` (pure computation, no
// filesystem/worker tricks), so those two are left bundleable.
//
// Usage: node scripts/build.js [--watch]
const { spawnSync, spawn } = require("child_process")
const path = require("path")

const root = path.join(__dirname, "..")
const watch = process.argv.includes("--watch")

// Packages that must stay as real `require(...)` calls in the output - see
// the comment above for why. Keep this in sync with package.json
// dependencies; anything *not* listed here gets bundled (currently just
// `three` and `crc`).
const EXTERNAL = [
	"@sentry/node",
	"@sentry/tracing",
	"arg",
	"chalk",
	"check-disk-space",
	"clarify",
	"decimal.js",
	"filtrex",
	"fs-extra",
	"hash-wasm",
	"json5",
	"klaw-sync",
	"lodash.isequal",
	"lodash.mergewith",
	"lossless-json",
	"luxon",
	"md5",
	"md5-file",
	"rfc6902",
	"semver",
	"tslib",
	"esbuild"
]

function typecheck() {
	const tscBin = path.join(root, "node_modules", "typescript", "bin", "tsc")
	const args = ["--noEmit"]
	if (watch) args.push("--watch", "--preserveWatchOutput")

	// This codebase has pre-existing type errors that don't block emit
	// (tsconfig.json doesn't set noEmitOnError), but `tsc` still exits
	// non-zero when it reports any diagnostic. In watch mode we just let it
	// print to the console in the background; in one-shot mode we run it
	// synchronously and warn-but-continue on non-zero exit, same behavior
	// the old tsc-lenient.js had (this project emits JS regardless).
	if (watch) {
		const child = spawn(process.execPath, [tscBin, ...args], { stdio: "inherit" })
		child.on("exit", (code) => {
			if (code !== 0 && code !== null) console.warn(`tsc --watch exited (${code})`)
		})
		return child
	}

	const result = spawnSync(process.execPath, [tscBin, ...args], { stdio: "inherit" })
	if (result.status !== 0) {
		console.warn(`tsc reported diagnostics (exit ${result.status}) - continuing, since this project emits JS regardless.`)
	}
	return null
}

function bundle() {
	const args = [
		"build",
		path.join(root, "src", "main.ts"),
		path.join(root, "src", "patchWorker.ts"),
		"--outdir",
		path.join(root, "build", "compiled"),
		"--target",
		"node",
		"--format",
		"cjs",
		"--sourcemap=linked"
	]
	for (const pkg of EXTERNAL) args.push("--external", pkg)
	if (watch) args.push("--watch")

	const result = spawnSync("bun", args, { stdio: "inherit", cwd: root })
	if (result.error) {
		console.error(`Couldn't run \`bun\` (${result.error.message}). Is it installed and on PATH? (see flake.nix / https://bun.sh)`)
		process.exit(1)
	}
	if (!watch && result.status !== 0) {
		process.exit(result.status ?? 1)
	}
	return result
}

if (watch) {
	// tsc --watch runs in the background just for diagnostics in the console;
	// `bun build --watch` is the foreground process that actually owns this
	// script's lifetime (Ctrl-C kills it, which then kills tsc too since it's
	// a child of this process).
	typecheck()
	bundle()
} else {
	typecheck()
	bundle()
	process.exit(0)
}
