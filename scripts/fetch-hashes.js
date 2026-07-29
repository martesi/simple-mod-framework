// Downloads the latest hitman-hashes release and extracts it into
// extra/Third-Party (the embedded framework core's dev-mode toolsRoot, see
// scripts/setup.js and src/main/paths.ts - a packaged build gets the same
// hashes via electron-builder.yml's extraResources instead, which now just
// copies this same folder wholesale, hash_list.txt included).
//
// Relies on 7z.exe already being present at extra/Third-Party/7z.exe
// (fetched by scripts/fetch-third-party.js) - so this must run after that
// script, same as scripts/setup.js already orders them.
//
// Usage: node scripts/fetch-hashes.js
import { execSync } from "child_process"
import fs from "fs"
import https from "https"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const url = "https://github.com/glacier-modding/hitman-hashes/releases/latest/download/latest-hashes.7z"
const tmp = path.join(os.tmpdir(), "latest-hashes.7z")
const dest = path.join(__dirname, "..", "extra", "Third-Party")

fs.mkdirSync(dest, { recursive: true })

function download(url, dest, cb) {
	const file = fs.createWriteStream(dest)
	https.get(url, (res) => {
		if (res.statusCode === 301 || res.statusCode === 302) {
			file.destroy()
			return download(res.headers.location, dest, cb)
		}
		if (res.statusCode !== 200) {
			file.destroy()
			return cb(new Error(`HTTP ${res.statusCode} fetching ${url}`))
		}
		res.pipe(file)
		file.on("finish", () => file.close(cb))
	}).on("error", (err) => {
		fs.unlink(dest, () => {})
		cb(err)
	})
}

const sevenZip = process.platform === "win32"
	? path.join(__dirname, "..", "extra", "Third-Party", "7z.exe")
	: "7z"

console.log("Fetching hitman-hashes...")
download(url, tmp, (err) => {
	if (err) {
		console.error("Download failed:", err.message)
		process.exit(1)
	}
	try {
		execSync(`"${sevenZip}" x "${tmp}" -o"${dest}" -y`, { stdio: "inherit" })
		fs.unlinkSync(tmp)
		console.log(`Extracted hitman-hashes to ${dest}`)
	} catch (e) {
		console.error("Extraction failed:", e.message)
		process.exit(1)
	}
})
