import fs from "fs"
import path from "path"

type DependencyCandidate = {
	rpkg: string
	chunk: string
	filePath: string
}

const chunkRpkgRegex = /00[0-9A-F]*\..*?\\(chunk[0-9]*(?:patch[0-9]*)?)\\/i
const chunkBaseRegex = /00[0-9A-F]*\..*?\\(chunk[0-9]*)(?:patch[0-9]*)?\\/i
const chunkMetaRegex = /^chunk[0-9]*(?:patch[0-9]*)?\.meta$/i

function walkFiles(root: string): string[] {
	const files: string[] = []
	const stack = [root]

	while (stack.length) {
		const current = stack.pop() as string
		const entries = fs.readdirSync(current, { withFileTypes: true })

		for (const entry of entries) {
			const fullPath = path.join(current, entry.name)

			if (entry.isDirectory()) {
				stack.push(fullPath)
			} else if (entry.isFile()) {
				files.push(fullPath)
			}
		}
	}

	return files
}

function naturalCompare(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
}

function parseDependencyCandidate(filePath: string): DependencyCandidate | null {
	const normalized = filePath.replace(/\//g, "\\")
	const rpkgMatch = normalized.match(chunkRpkgRegex)
	const chunkMatch = normalized.match(chunkBaseRegex)

	if (!rpkgMatch || !chunkMatch) {
		return null
	}

	return {
		rpkg: rpkgMatch[1],
		chunk: chunkMatch[1],
		filePath
	}
}

export function stageDependenciesFrom(fromFolder: string, toFolder: string) {
	if (!fs.existsSync(fromFolder)) {
		return
	}

	const allCandidates = walkFiles(fromFolder)
		.map(parseDependencyCandidate)
		.filter((candidate): candidate is DependencyCandidate => candidate !== null)
		.sort((a, b) => {
			const chunkOrder = naturalCompare(a.chunk, b.chunk)
			if (chunkOrder !== 0) {
				return chunkOrder
			}

			return naturalCompare(b.rpkg, a.rpkg)
		})

	const selectedPaths: string[] = []
	const seenFileNames = new Set<string>()

	for (const candidate of allCandidates) {
		const fileName = path.basename(candidate.filePath)
		if (!seenFileNames.has(fileName)) {
			seenFileNames.add(fileName)
			selectedPaths.push(candidate.filePath)
		}
	}

	const stagingDir = path.join(process.cwd(), "staging", toFolder)
	fs.mkdirSync(stagingDir, { recursive: true })

	for (const filePath of selectedPaths) {
		const fileName = path.basename(filePath)
		if (chunkMetaRegex.test(fileName)) {
			continue
		}

		const targetPath = path.join(stagingDir, fileName)
		if (fs.existsSync(targetPath)) {
			continue
		}

		if (path.extname(targetPath).toLowerCase() === ".meta" && fs.existsSync(`${targetPath}.json`)) {
			continue
		}

		fs.copyFileSync(filePath, targetPath)
	}
}

export function freeDiskSpace(): number {
	const statFsSync = (
		fs as unknown as {
			statfsSync?: (targetPath: string) => { bavail: number | bigint; bsize: number | bigint }
		}
	).statfsSync

	if (!statFsSync) {
		return 0
	}

	const statFs = statFsSync(process.cwd())
	const available = typeof statFs.bavail === "bigint" ? Number(statFs.bavail) : statFs.bavail
	const blockSize = typeof statFs.bsize === "bigint" ? Number(statFs.bsize) : statFs.bsize

	return available * blockSize
}
