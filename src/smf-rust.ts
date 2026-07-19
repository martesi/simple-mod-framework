// Pure-JS replacement for the former `rust/` napi addon (smf-rust.node).
//
// That addon only ever targeted x86_64-pc-windows-msvc (this CLI is Windows-only,
// see justfile/pkg target node18-win-x64) and exposed two small, I/O-bound
// helpers - neither did anything that needed to be compiled. Porting them here
// drops the whole napi-rs/yarn subproject, the pkg native-asset-embedding step,
// and the Rust toolchain requirement for anyone touching this logic.
//
// See rust/src/lib.rs in git history for the original implementation this was
// ported from.

import checkDiskSpace from "check-disk-space"
import fs from "fs-extra"
import klaw from "klaw-sync"
import path from "path"

/**
 * Natural-order comparator (so "chunk9" sorts before "chunk10"), matching the
 * ordering semantics of the Rust `human-sort` crate used by the original addon.
 */
function naturalCompare(a: string, b: string): number {
	const chunkPattern = /(\d+|\D+)/g
	const aParts = a.match(chunkPattern) || [a]
	const bParts = b.match(chunkPattern) || [b]

	const length = Math.max(aParts.length, bParts.length)
	for (let i = 0; i < length; i++) {
		const aPart = aParts[i] ?? ""
		const bPart = bParts[i] ?? ""

		if (aPart === bPart) continue

		const aIsNumeric = /^\d+$/.test(aPart)
		const bIsNumeric = /^\d+$/.test(bPart)

		if (aIsNumeric && bIsNumeric) {
			const diff = Number(aPart) - Number(bPart)
			if (diff !== 0) return diff
		} else {
			return aPart < bPart ? -1 : 1
		}
	}

	return 0
}

/**
 * Walks `fromFolder`, figures out which RPKG chunk/patch each file belongs to,
 * keeps only the highest-priority version of each filename (patches beat their
 * base chunk, sorted in descending order), drops chunk .meta files that already
 * have a .meta.json sibling, and copies the survivors into staging/<toFolder>.
 *
 * Synchronous by design - callers (deploy.ts) rely on staging/ being fully
 * populated by the time this returns, just like the old native call was.
 */
export function stageDependenciesFrom(fromFolder: string, toFolder: string): void {
	const reRpkg = /00[0-9A-F]*\..*?\\(chunk[0-9]*(?:patch[0-9]*)?)\\/i
	const reRpkgChunk = /00[0-9A-F]*\..*?\\(chunk[0-9]*)(?:patch[0-9]*)?\\/i
	const reMeta = /chunk[0-9]*(?:patch[0-9]*)?\.meta/i

	const allFiles = klaw(fromFolder)
		.filter((entry) => entry.stats.isFile())
		.map((entry) => {
			const rpkgMatch = entry.path.match(reRpkg)
			const chunkMatch = entry.path.match(reRpkgChunk)

			if (!rpkgMatch || !chunkMatch) {
				throw new Error(`Invalid RPKG file, remove it from Runtime: ${entry.path}`)
			}

			return {
				rpkg: rpkgMatch[1],
				chunk: chunkMatch[1],
				path: entry.path
			}
		})

	// Sort by chunk ascending; within the same chunk, sort patches descending
	// (so the newest patch for a chunk comes first).
	allFiles.sort((a, b) => {
		const chunkOrder = naturalCompare(a.chunk, b.chunk)
		return chunkOrder !== 0 ? chunkOrder : -naturalCompare(a.rpkg, b.rpkg)
	})

	// Keep only the first (highest-priority, given the sort above) occurrence
	// of each filename.
	const seenFilenames = new Set<string>()
	const supersededFiles: string[] = []
	for (const { path: filePath } of allFiles) {
		const fileName = path.basename(filePath)
		if (!seenFilenames.has(fileName)) {
			seenFilenames.add(fileName)
			supersededFiles.push(filePath)
		}
	}

	// Remove all chunk metas.
	const filesToStage = supersededFiles.filter((filePath) => !reMeta.test(path.basename(filePath)))

	const stagingDir = path.join("staging", toFolder)
	fs.ensureDirSync(stagingDir)

	for (const filePath of filesToStage) {
		const dest = path.join(stagingDir, path.basename(filePath))

		if (!fs.existsSync(dest)) {
			if (path.extname(dest) === ".meta" && fs.existsSync(`${dest}.json`)) {
				continue
			}

			fs.copyFileSync(filePath, dest)
		}
	}
}

/**
 * Available disk space (in bytes) on the drive containing the current working
 * directory.
 */
export async function freeDiskSpace(): Promise<number> {
	const diskSpace = await checkDiskSpace(process.cwd())
	return diskSpace.free
}
