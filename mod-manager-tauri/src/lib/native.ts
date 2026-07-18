/**
 * native.ts — invoke-backed shim that exposes the same API surface as the
 * Electron preload (window.fs, window.path, window.klaw, etc.) but as named
 * async exports.  Component files import from here instead of using window.*
 */
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { open as dialogOpen } from "@tauri-apps/plugin-dialog"
import { openUrl } from "@tauri-apps/plugin-opener"

// ─── path utilities (pure string, no OS call) ──────────────────────────────

function pathNormalize(p: string): string {
	const absolute = p.startsWith("/")
	const parts = p.split(/[/\\]+/).filter(Boolean)
	const result: string[] = []
	for (const part of parts) {
		if (part === "..") {
			// like Node's path.normalize: leading ".." segments of a relative
			// path must be preserved, not dropped — the Rust side anchors them
			// to the app dir ("../Mods" is the framework root's Mods folder)
			if (result.length && result[result.length - 1] !== "..") result.pop()
			else if (!absolute) result.push("..")
		} else if (part !== ".") {
			result.push(part)
		}
	}
	return (absolute ? "/" : "") + result.join("/")
}

export const path = {
	join: (...parts: string[]): string => pathNormalize(parts.join("/")),
	resolve: (...parts: string[]): string => pathNormalize(parts.join("/")),
	basename: (p: string, ext?: string): string => {
		const base =
			p
				.replace(/[/\\]+$/, "")
				.split(/[/\\]/)
				.pop() ?? p
		if (ext && base.endsWith(ext)) return base.slice(0, -ext.length)
		return base
	},
	dirname: (p: string): string => {
		const normalized = pathNormalize(p)
		const idx = normalized.lastIndexOf("/")
		return idx <= 0 ? (normalized.startsWith("/") ? "/" : ".") : normalized.slice(0, idx)
	},
	sep: "/",

	relative: (from: string, to: string): string => {
		const fromParts = from.replace(/\\/g, "/").split("/").filter(Boolean)
		const toParts = to.replace(/\\/g, "/").split("/").filter(Boolean)
		let common = 0
		while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++
		return Array(fromParts.length - common)
			.fill("..")
			.concat(toParts.slice(common))
			.join("/")
	}
}

// ─── filesystem (invoke → Rust fs_bridge) ──────────────────────────────────

export const fs = {
	readFileSync: (p: string, _enc?: string): Promise<string> => invoke("fs_read_text", { path: p }),

	writeFileSync: (p: string, data: string): Promise<void> => invoke("fs_write_text", { path: p, data }),

	existsSync: (p: string): Promise<boolean> => invoke("fs_exists", { path: p }),

	readdirSync: (p: string): Promise<string[]> => invoke("fs_read_dir", { path: p }),

	copySync: (src: string, dest: string): Promise<void> => invoke("fs_copy", { src, dest }),

	copyFileSync: (src: string, dest: string): Promise<void> => invoke("fs_copy_file", { src, dest }),

	removeSync: (p: string): Promise<void> => invoke("fs_remove", { path: p }),

	emptyDirSync: (p: string): Promise<void> => invoke("fs_empty_dir", { path: p }),

	ensureDirSync: (p: string): Promise<void> => invoke("fs_ensure_dir", { path: p }),

	readJSONSync: async (p: string): Promise<unknown> => JSON.parse(await invoke<string>("fs_read_text", { path: p }))
}

// ─── file metadata ──────────────────────────────────────────────────────────

export const isFile = (p: string): Promise<boolean> => invoke("fs_is_file", { path: p })

// ─── directory walk (invoke → Rust klaw_walk) ──────────────────────────────

export const klaw = (dir: string, opts?: { nodir?: boolean; depthLimit?: number }): Promise<{ path: string }[]> =>
	invoke("klaw_walk", {
		path: dir,
		nodir: opts?.nodir ?? false,
		depthLimit: opts?.depthLimit ?? -1
	})

// ─── archive extraction ─────────────────────────────────────────────────────

export const extractArchive = (archivePath: string, destDir: string): Promise<void> => invoke("extract_archive", { archivePath, destDir })

/**
 * Write raw binary (from a network fetch) to disk as a temp archive.
 * Encodes in base64 chunks to avoid the spread-operator stack limit.
 */
export const writeTempBytes = (p: string, data: Uint8Array): Promise<void> => {
	const chunks: string[] = []
	for (let i = 0; i < data.length; i += 32768) {
		chunks.push(String.fromCharCode(...data.subarray(i, i + 32768)))
	}
	const dataBase64 = btoa(chunks.join(""))
	return invoke("write_temp_bytes", { path: p, dataBase64 })
}

// ─── deploy ─────────────────────────────────────────────────────────────────

export const runDeploy = (): Promise<void> => invoke("run_deploy")

export const onDeployOutput = (cb: (output: string) => void) => listen<string>("deploy-output", (e) => cb(e.payload))

export const onDeployFinished = (cb: () => void) => listen<void>("deploy-finished", () => cb())

// ─── framework paths ────────────────────────────────────────────────────────

export const getFrameworkRoot = (): Promise<string> => invoke("get_framework_root")
export const getAppDir = (): Promise<string> => invoke("get_app_dir")

// ─── dialogs ────────────────────────────────────────────────────────────────

function pickFirst(r: string | string[] | null): string | null {
	return Array.isArray(r) ? (r[0] ?? null) : r
}

export const openModFileDialog = (): Promise<string | null> =>
	dialogOpen({
		title: "Add a mod file",
		filters: [{ name: "Mod Files", extensions: ["zip", "7z", "rar", "rpkg"] }],
		multiple: false,
		directory: false
	}).then(pickFirst)

export const openRpkgDialog = (): Promise<string | null> =>
	dialogOpen({
		title: "Select an RPKG file",
		filters: [{ name: "RPKG Files", extensions: ["rpkg"] }],
		multiple: false,
		directory: false
	}).then(pickFirst)

export const openImageDialog = (): Promise<string | null> =>
	dialogOpen({
		title: "Select an image",
		filters: [
			{
				name: "Image Files",
				extensions: ["png", "jpg", "apng", "gif", "webp", "svg", "jpeg", "jfif"]
			}
		],
		multiple: false,
		directory: false
	}).then(pickFirst)

// ─── shell / external links ─────────────────────────────────────────────────

export const openExternalLink = (url: string): Promise<void> => openUrl(url)
