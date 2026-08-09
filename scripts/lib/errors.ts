export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export function errorStack(error: unknown): string | undefined {
	return error instanceof Error ? error.stack : undefined
}
