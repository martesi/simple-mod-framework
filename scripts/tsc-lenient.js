// Runs the project's own local `typescript` devDependency and always exits 0.
//
// This codebase has pre-existing type errors that don't block emit (tsconfig.json
// doesn't set noEmitOnError), but `tsc` still exits non-zero when it reports any
// diagnostic, which would fail a CI step. The previous CI worked around this by
// installing a *different*, unpinned global `typescript` (new enough to support
// `tsc --noCheck`, which skips checking entirely) or a separate `tsc-silent`
// package. Both mask the project's pinned compiler version instead of using it.
//
// Using the local compiler and just ignoring its exit code reproduces the same
// "emit regardless of type errors" behavior without installing anything extra.
const { spawnSync } = require("child_process")
const path = require("path")

const tscBin = path.join(__dirname, "..", "node_modules", "typescript", "bin", "tsc")

const result = spawnSync(process.execPath, [tscBin, ...process.argv.slice(2)], {
	stdio: "inherit"
})

if (result.status !== 0) {
	console.warn(`tsc reported diagnostics (exit ${result.status}) - continuing, since this project emits JS regardless.`)
}

process.exit(0)
