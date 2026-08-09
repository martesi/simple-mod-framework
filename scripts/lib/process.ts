import { pathExists } from "./files"

type ProcessIo = "inherit" | "ignore" | "pipe"

export interface RunProcessOptions {
	cwd?: string
	stdin?: ProcessIo
	stdout?: ProcessIo
	stderr?: ProcessIo
}

export async function runProcess(command: string, args: readonly string[] = [], options: RunProcessOptions = {}): Promise<void> {
	const child = Bun.spawn([command, ...args], {
		cwd: options.cwd,
		stdin: options.stdin ?? "ignore",
		stdout: options.stdout ?? "inherit",
		stderr: options.stderr ?? "inherit"
	})
	const exitCode = await child.exited
	if (exitCode !== 0) {
		const commandLine = [command, ...args].join(" ")
		throw new Error(`${commandLine} exited with code ${exitCode}`)
	}
}

/** Return the first runnable executable in PATH, optionally checking it with a probe command. */
export async function findExecutable(candidates: readonly string[], probeArgs: readonly string[] = []): Promise<string | null> {
	for (const candidate of candidates) {
		const executable = candidate.includes("/") || candidate.includes("\\") ? (await pathExists(candidate) ? candidate : null) : Bun.which(candidate)
		if (!executable) continue
		if (probeArgs.length === 0) return executable

		try {
			await runProcess(executable, probeArgs, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
			return executable
		} catch {
			// The command was found but could not run the probe; try the next candidate.
		}
	}
	return null
}
