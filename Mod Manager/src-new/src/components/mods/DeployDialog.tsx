import { Check, ChevronDown } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/store/app-store"
import { cn } from "@/lib/utils"
import type { DeployStage } from "@/lib/ipc"

const STAGES: { key: DeployStage; label: string }[] = [
  { key: "sorting", label: "Sorting load order" },
  { key: "extracting", label: "Extracting RPKG mods" },
  { key: "patching", label: "Patching game files" },
  { key: "finalizing", label: "Finalizing" }
]

export function DeployDialog() {
  const deploy = useAppStore((s) => s.deploy)
  const closeDeploy = useAppStore((s) => s.closeDeploy)
  const toggleDeployLog = useAppStore((s) => s.toggleDeployLog)

  if (!deploy.snapshot) return null

  const currentStageIndex = deploy.progress?.stageIndex ?? -1
  const done = deploy.progress?.done ?? false
  const snapshotTimeLabel = new Date(deploy.snapshot.snapshotTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })

  return (
    <Dialog open={deploy.open} onOpenChange={(open) => !open && closeDeploy()}>
      <DialogContent hideClose className="max-w-[480px] max-h-[80vh] overflow-hidden flex flex-col p-0">
        <div className="px-6 pb-1 pt-5">
          <div className="mb-0.5 text-[16px] font-bold text-text">Applying your mods</div>
          <div className="text-[12.5px] text-text-2">
            {done ? "Deploy finished successfully." : "This may take a moment — hang tight."} Deploying against the config frozen at {snapshotTimeLabel} ({deploy.snapshot.loadOrder.length} mods) —
            changes you make now will apply to the next deploy.
          </div>
        </div>

        <div className="px-6 py-4">
          {STAGES.map((stage, i) => {
            const isDone = currentStageIndex > i || done
            const isActive = currentStageIndex === i && !done
            return (
              <div key={stage.key} className="flex items-center gap-3 py-[9px]">
                <div
                  className={cn(
                    "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full",
                    isDone ? "bg-success text-white" : isActive ? "bg-accent text-accent-foreground" : "bg-surface-2"
                  )}
                >
                  {isDone && <Check className="h-3 w-3" strokeWidth={3} />}
                  {isActive && <div className="h-[10px] w-[10px] animate-spin-slow rounded-full border-2 border-accent-foreground border-t-transparent" />}
                </div>
                <div className={cn("text-[13.5px]", isDone || isActive ? "text-text" : "text-text-3")}>
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
          <button onClick={toggleDeployLog} className="flex items-center gap-1.5 px-6 py-[11px] text-[12.5px] font-semibold text-text-2">
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", deploy.logExpanded && "rotate-180")} /> Show raw log
          </button>
          {deploy.logExpanded && (
            <pre className="m-0 max-h-40 overflow-y-auto whitespace-pre-wrap bg-surface-2 px-6 pb-4 pt-0 font-mono text-[11.5px] leading-relaxed text-text-2">{deploy.log.join("\n") || "…"}</pre>
          )}
        </div>

        <div className="flex justify-end gap-2.5 border-t border-border px-6 py-4">
          <Button variant={done ? "default" : "secondary"} onClick={closeDeploy}>
            {done ? "Done" : "Cancel"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
