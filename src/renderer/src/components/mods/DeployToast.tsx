import { Check, ChevronDown, TriangleAlert, X } from "lucide-react"
import { useAppStore } from "@/store/app-store"
import { cn } from "@/lib/utils"
import type { DeployStage } from "@/lib/ipc"

// Matches deployManager.ts's STAGE_INDEX ordering exactly - "waiting-for-cache-build" (LEI-141's
// queue-aware deploy gate) only ever actually shows when at least one mod in the load order isn't
// eager-built yet; most deploys skip straight past it to "sorting", same as before this stage existed.
const STAGES: { key: DeployStage; label: string }[] = [
  { key: "waiting-for-cache-build", label: "Waiting for mods to finish building" },
  { key: "sorting", label: "Sorting load order" },
  { key: "extracting", label: "Extracting RPKG mods" },
  { key: "patching", label: "Patching game files" },
  { key: "finalizing", label: "Finalizing" }
]

/**
 * Non-blocking deploy status, bottom-right - no backdrop, the rest of the app
 * stays usable while a deploy runs. Mirrors the toast in
 * new-ui/Mod Manager.dc.html (this replaced an earlier centered modal design).
 */
export function DeployToast() {
  const deploy = useAppStore((s) => s.deploy)
  const closeDeploy = useAppStore((s) => s.closeDeploy)
  const toggleDeployExpanded = useAppStore((s) => s.toggleDeployExpanded)
  const toggleDeployLog = useAppStore((s) => s.toggleDeployLog)

  if (!deploy.open || !deploy.snapshot) return null

  const currentStageIndex = deploy.progress?.stageIndex ?? -1
  const done = deploy.progress?.done ?? false
  // `done` alone only means "the pipeline stopped running" - deployManager.ts sets it on both the
  // success and failure paths (see its "finalizing"/ok:false emits, e.g. the queue-aware gate's
  // build-wait timeout). `ok` is what actually distinguishes the two.
  const failed = done && deploy.progress?.ok === false
  const progressPct = done ? 100 : Math.round(((Math.max(currentStageIndex, 0) + 0.5) / STAGES.length) * 100)

  let statusLine = "This may take a moment…"
  if (failed) {
    statusLine = deploy.progress?.logLine || "Deploy failed."
  } else if (done) {
    statusLine = "Deploy finished successfully."
  } else if (currentStageIndex >= 0) {
    const stage = STAGES[currentStageIndex]
    statusLine =
      stage.key === "patching" && deploy.progress?.currentModId
        ? `${stage.label} — ${deploy.progress.currentModId} (${(deploy.progress.modIndex ?? 0) + 1}/${deploy.progress.modTotal})`
        : stage.label
  }

  return (
    <div className="absolute bottom-5 right-5 z-[100] flex max-h-[70vh] w-[360px] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-md animate-fade-in">
      <div onClick={toggleDeployExpanded} className="flex cursor-pointer items-center gap-3 px-4 py-3.5">
        <div
          className={cn(
            "flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-accent-foreground",
            failed ? "bg-danger" : done ? "bg-success" : "bg-accent"
          )}
        >
          {failed ? (
            <TriangleAlert className="h-3 w-3" strokeWidth={3} />
          ) : done ? (
            <Check className="h-3 w-3" strokeWidth={3} />
          ) : (
            <div className="h-[11px] w-[11px] animate-spin-slow rounded-full border-2 border-accent-foreground border-t-transparent" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-bold text-text">{failed ? "Deploy failed" : done ? "Mods applied" : "Applying your mods"}</div>
          <div className="truncate text-[12px] text-text-2">{statusLine}</div>
        </div>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-text-3 transition-transform", deploy.expanded && "rotate-180")} />
        <button
          onClick={(e) => {
            e.stopPropagation()
            closeDeploy()
          }}
          title="Dismiss"
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-surface-hover"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      <div className="h-[3px] shrink-0 bg-surface-2">
        <div className="h-full bg-accent transition-all duration-300" style={{ width: `${progressPct}%` }} />
      </div>

      {deploy.expanded && (
        <div className="overflow-y-auto">
          <div className="px-4 pb-1 pt-3">
            {STAGES.map((stage, i) => {
              const isDone = currentStageIndex > i || (done && !failed)
              const isFailedHere = failed && currentStageIndex === i
              const isActive = currentStageIndex === i && !done
              return (
                <div key={stage.key} className="flex items-center gap-3 py-[7px]">
                  <div
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-accent-foreground",
                      isFailedHere ? "bg-danger" : isDone ? "bg-success" : isActive ? "bg-accent" : "bg-surface-2"
                    )}
                  >
                    {isFailedHere && <TriangleAlert className="h-2.5 w-2.5" strokeWidth={3} />}
                    {isDone && !isFailedHere && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                    {isActive && <div className="h-[9px] w-[9px] animate-spin-slow rounded-full border-2 border-accent-foreground border-t-transparent" />}
                  </div>
                  <div className={cn("text-[13px]", isDone || isActive || isFailedHere ? "text-text" : "text-text-3")}>
                    {stage.label}
                    {isActive && stage.key === "patching" && deploy.progress?.currentModId && (
                      <span className="text-text-2">
                        {" "}
                        — {deploy.progress.currentModId} ({(deploy.progress.modIndex ?? 0) + 1}/{deploy.progress.modTotal})
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="border-t border-border">
            <button onClick={toggleDeployLog} className="flex w-full items-center gap-1.5 px-4 py-[10px] text-[12px] font-semibold text-text-2">
              <ChevronDown className={cn("h-3 w-3 transition-transform", deploy.logExpanded && "rotate-180")} /> Show raw log
            </button>
            {deploy.logExpanded && (
              <pre className="m-0 max-h-[140px] overflow-y-auto whitespace-pre-wrap bg-surface-2 px-4 pb-3.5 pt-0 font-mono text-[11px] leading-relaxed text-text-2">
                {deploy.log.join("\n") || "…"}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
