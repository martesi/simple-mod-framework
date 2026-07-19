// Downloads the latest hitman-hashes release and extracts it into dist/Third-Party/.
// Mirrors the "Fetch hitman-hashes" step in the GitHub CI workflows.
const child_process = require("child_process")
const fs = require("fs")
const https = require("https")
const os = require("os")
const path = require("path")

const url = "https://github.com/glacier-modding/hitman-hashes/releases/latest/download/latest-hashes.7z"
const tmp = path.join(os.tmpdir(), "latest-hashes.7z")
const dest = path.join(__dirname, "..", "dist", "Third-Party")

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
	? path.join(__dirname, "..", "build", "Third-Party", "7z.exe")
	: "7z"

console.log("Fetching hitman-hashes...")
download(url, tmp, (err) => {
	if (err) {
		console.error("Download failed:", err.message)
		process.exit(1)
	}
	try {
		child_process.execSync(`"${sevenZip}" x "${tmp}" -o"${dest}" -y`, { stdio: "inherit" })
		fs.unlinkSync(tmp)
		console.log(`Extracted hitman-hashes to ${dest}`)
	} catch (e) {
		console.error("Extraction failed:", e.message)
		process.exit(1)
	}
})
