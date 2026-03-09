const fs = require("fs")
const os = require("os")
const path = require("path")
const https = require("https")
const { spawnSync } = require("child_process")

const repoRoot = path.resolve(__dirname, "..")
const thirdPartyDir = path.join(repoRoot, "Third-Party")
const forBuildThirdPartyDir = path.join(repoRoot, "For Build", "Third-Party")

const vendoredFromForBuild = [
	"ResourceTool.exe",
	"ResourceLib_HM2016.dll",
	"ResourceLib_HM2.dll",
	"ResourceLib_HM3.dll",
	"assimp.dll",
	"quickentity_ffi.dll",
	"hash_list.hmla"
]

const requiredExecutables = [
	"7z.exe",
	"HMLanguageTools.exe",
	"HMTextureTools.exe",
	"OREStool.exe",
	"quickentity-3.exe",
	"quickentity-rs.exe",
	"xdelta3.exe",
	"ResourceTool.exe",
	"rpkg-cli.exe"
]

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true })
}

function copyIfMissing(from, to) {
	if (fs.existsSync(to)) {
		return false
	}
	if (!fs.existsSync(from)) {
		return false
	}
	fs.copyFileSync(from, to)
	return true
}

function request(url, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { headers }, (res) => {
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				resolve(request(res.headers.location, headers))
				return
			}
			if (res.statusCode !== 200) {
				reject(new Error(`Request failed (${res.statusCode}) for ${url}`))
				return
			}
			const chunks = []
			res.on("data", (chunk) => chunks.push(chunk))
			res.on("end", () => resolve(Buffer.concat(chunks)))
		})
		req.on("error", reject)
	})
}

async function downloadLatestGitHubReleaseAsset(owner, repo, matcher) {
	const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`
	const releaseBuffer = await request(apiUrl, {
		"User-Agent": "simple-mod-framework-setup-tools",
		"Accept": "application/vnd.github+json"
	})
	const release = JSON.parse(releaseBuffer.toString("utf8"))
	const assets = Array.isArray(release.assets) ? release.assets : []
	const asset = assets.find((a) => matcher.test(a.name)) || assets.find((a) => /rpkg.*cli/i.test(a.name))

	if (!asset || !asset.browser_download_url) {
		throw new Error(`No matching release asset found in ${owner}/${repo}`)
	}

	const tmpFilePath = path.join(os.tmpdir(), `smf-${Date.now()}-${asset.name}`)
	const binaryBuffer = await request(asset.browser_download_url, {
		"User-Agent": "simple-mod-framework-setup-tools",
		"Accept": "application/octet-stream"
	})
	fs.writeFileSync(tmpFilePath, binaryBuffer)
	return tmpFilePath
}

function findFileRecursive(root, predicate) {
	const stack = [root]
	while (stack.length) {
		const current = stack.pop()
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const fullPath = path.join(current, entry.name)
			if (entry.isDirectory()) {
				stack.push(fullPath)
			} else if (entry.isFile() && predicate(entry.name, fullPath)) {
				return fullPath
			}
		}
	}
	return null
}

function extractZipOnWindows(zipPath, outputDir) {
	const cmd = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outputDir.replace(/'/g, "''")}' -Force`
	const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd], { stdio: "inherit" })
	if (result.status !== 0) {
		throw new Error(`Failed to extract zip: ${zipPath}`)
	}
}

async function ensureRpkgCli() {
	const rpkgCliPath = path.join(thirdPartyDir, "rpkg-cli.exe")
	if (fs.existsSync(rpkgCliPath)) {
		return false
	}

	if (process.platform !== "win32") {
		throw new Error("Automatic rpkg-cli download is only supported on Windows for this project.")
	}

	const downloaded = await downloadLatestGitHubReleaseAsset("glacier-modding", "RPKG-Tool", /rpkg.*cli.*(win|windows|x64|amd64|64).*\.zip$/i)
	let sourceExe = downloaded

	if (downloaded.toLowerCase().endsWith(".zip")) {
		const extractDir = path.join(os.tmpdir(), `smf-rpkg-cli-${Date.now()}`)
		ensureDir(extractDir)
		extractZipOnWindows(downloaded, extractDir)
		const discovered = findFileRecursive(extractDir, (name) => /^rpkg-cli(?:\.exe)?$/i.test(name))
		if (!discovered) {
			throw new Error("Downloaded RPKG-Tool asset did not contain rpkg-cli.exe")
		}
		sourceExe = discovered
	}

	fs.copyFileSync(sourceExe, rpkgCliPath)
	return true
}

async function main() {
	ensureDir(thirdPartyDir)

	const synced = []
	for (const fileName of vendoredFromForBuild) {
		const fromPath = path.join(forBuildThirdPartyDir, fileName)
		const toPath = path.join(thirdPartyDir, fileName)
		if (copyIfMissing(fromPath, toPath)) {
			synced.push(fileName)
		}
	}

	const downloaded = []
	if (await ensureRpkgCli()) {
		downloaded.push("rpkg-cli.exe")
	}

	const missing = requiredExecutables.filter((fileName) => !fs.existsSync(path.join(thirdPartyDir, fileName)))
	if (missing.length) {
		console.error("Missing required third-party tools:")
		for (const fileName of missing) {
			console.error(`- Third-Party/${fileName}`)
		}
		process.exit(1)
	}

	if (synced.length) {
		console.log(`Synced from For Build: ${synced.join(", ")}`)
	}
	if (downloaded.length) {
		console.log(`Downloaded: ${downloaded.join(", ")}`)
	}
	console.log("Third-party tools are ready.")
}

main().catch((error) => {
	console.error(error.message)
	process.exit(1)
})
