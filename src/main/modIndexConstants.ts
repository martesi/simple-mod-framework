export const MANAGED_FOLDER = "Managed by SMF, do not touch"

export function majorVersion(version: string): number {
	const n = Number.parseInt(version.split(".")[0], 10)
	return Number.isFinite(n) ? n : 0
}
