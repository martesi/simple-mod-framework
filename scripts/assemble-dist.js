// Assembles the ./dist release folder from the various build outputs.
//
// Replaces the block of `robocopy`/`New-Item` PowerShell steps duplicated
// across the CI workflows so the same logic runs identically in CI (Windows
// or Linux) and locally.
//
// Usage: node scripts/assemble-dist.js <win|linux>
const fs = require("fs")
const path = require("path")

const platform = process.argv[2]
if (platform !== "win" && platform !== "linux") {
	console.error("Usage: node scripts/assemble-dist.js <win|linux>")
	process.exit(1)
}

const root = path.join(__dirname, "..")
const dist = path.join(root, "dist")

fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(path.join(dist, "Third-Party"), { recursive: true })
fs.mkdirSync(path.join(dist, "Info"), { recursive: true })
fs.mkdirSync(path.join(dist, "API"), { recursive: true })
fs.mkdirSync(path.join(dist, "Mod Manager"), { recursive: true })

// Third-Party/ is flat, and postinstall (scripts/link-third-party.js) links
// the tracked subset of it from For Build/Third-Party/ rather than copying
// it. fs.cpSync's `dereference` option doesn't reliably turn those links
// into real files (it can end up recreating a symlink at the destination
// that only resolves on this machine), so copy file-by-file with
// copyFileSync instead - it always reads through a symlink and writes real
// bytes at the destination, never a link.
for (const file of fs.readdirSync(path.join(root, "build", "Third-Party"))) {
	fs.copyFileSync(path.join(root, "build", "Third-Party", file), path.join(dist, "Third-Party", file))
}
fs.cpSync(path.join(root, "For Build"), dist, { recursive: true })
fs.cpSync(path.join(root, "docs"), path.join(dist, "Info"), { recursive: true })

for (const file of fs.readdirSync(path.join(root, "build", "compiled"))) {
	if (file.endsWith(".d.ts")) {
		fs.copyFileSync(path.join(root, "build", "compiled", file), path.join(dist, "API", file))
	}
}

const unpackedDir = platform === "win" ? "win-unpacked" : "linux-unpacked"
fs.cpSync(path.join(root, "Mod Manager", "dist", unpackedDir), path.join(dist, "Mod Manager"), { recursive: true })

fs.copyFileSync(path.join(root, "build", "Deploy.exe"), path.join(dist, "Deploy.exe"))

if (platform === "win") {
	fs.writeFileSync(path.join(dist, "Mod Manager.cmd"), '@echo off\r\ncd "Mod Manager"\r\nstart "" "Mod Manager.exe"\r\n')
} else {
	const launcher = path.join(dist, "Mod Manager.sh")
	fs.writeFileSync(launcher, '#!/bin/sh\ncd "$(dirname "$0")/Mod Manager"\nexec ./modmanager "$@"\n')
	fs.chmodSync(launcher, 0o755)
}

console.log(`Assembled dist/ for ${platform}`)
