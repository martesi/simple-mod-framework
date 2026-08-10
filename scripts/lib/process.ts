import { pathExists } from "./files"
import * as TE from "fp-ts/TaskEither"
import { scriptError, type ScriptError } from "./effects"

type ProcessIo = "inherit" | "ignore" | "pipe"

export interface RunProcessOptions {
	cwd?: string
	stdin?: ProcessIo
	stdout?: ProcessIo
	stderr?: ProcessIo
}

export function runProcess(command: string, args: readonly string[] = [], options: RunProcessOptions = {}): TE.TaskEither<ScriptError, void> {
	return TE.tryCatch(async () => {
		const child = Bun.spawn([command, ...args], { cwd: options.cwd, stdin: options.stdin ?? "ignore", stdout: options.stdout ?? "inherit", stderr: options.stderr ?? "inherit" })
		const exitCode = await child.exited
		if (exitCode !== 0) throw scriptError("run process", `${[command, ...args].join(" ")} exited with code ${exitCode}`, { process: { command, args, exitCode } })
	}, (cause) => cause && typeof cause === "object" && "_tag" in cause ? cause as ScriptError : scriptError("run process", String(cause), { cause, process: { command, args } }))
}

/** Return the first runnable executable in PATH, optionally checking it with a probe command. */
export function findExecutable(candidates: readonly string[], probeArgs: readonly string[] = []): TE.TaskEither<ScriptError, string | null> {
	return TE.rightTask(async () => {
		for (const candidate of candidates) {
			const existing = candidate.includes("/") || candidate.includes("\\") ? await pathExists(candidate)() : undefined
			const executable = candidate.includes("/") || candidate.includes("\\") ? existing?._tag === "Right" && existing.right ? candidate : null : Bun.which(candidate)
			if (!executable) continue
			if (probeArgs.length === 0) return executable
			const result = await runProcess(executable, probeArgs, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })()
			if (result._tag === "Right") return executable
		}
		return null
	})
}
