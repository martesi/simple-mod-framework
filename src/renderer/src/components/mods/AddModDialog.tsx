import { useRef, useState } from "react"
import { CircleCheck, CircleX, Loader2, UploadCloud } from "lucide-react"

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/store/app-store"
import { cn } from "@/lib/utils"

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued…",
  extracting: "Extracting archive…",
  validating: "Validating manifest…",
  installing: "Copying into Mods…",
  done: "Installed",
  error: "Failed"
}

export function AddModDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  // Each file gets its own independent add task - looping and firing them all off here (rather
  // than awaiting one before starting the next) is exactly the "non-blocking add" behavior
  // LEI-137 calls for. Lifted to app-store.ts's addFiles() so App.tsx's whole-window drop handler
  // can feed the same pipeline this dialog's own dropzone does, instead of the two drifting apart.
  const addFiles = useAppStore((s) => s.addFiles)
  const addTasks = useAppStore((s) => s.addTasks)
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const tasks = Object.values(addTasks).sort((a, b) => a.startedAt - b.startedAt)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a mod</DialogTitle>
          <DialogDescription>Drop one or more mod archives (.zip, .7z, .rar) or raw .rpkg files. Each one installs independently.</DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-2">
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              addFiles(e.dataTransfer.files)
            }}
            onClick={() => inputRef.current?.click()}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border py-10 text-center transition-colors",
              dragOver && "border-accent bg-accent-soft"
            )}
          >
            <UploadCloud className="h-7 w-7 text-text-3" />
            <div className="text-[13px] text-text">Drop mod files here, or click to browse</div>
            <div className="text-[12px] text-text-3">Multiple files install in parallel</div>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".zip,.7z,.rar,.rpkg"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ""
              }}
            />
          </div>

          {tasks.length > 0 && (
            <div className="mt-4 flex flex-col gap-2">
              {tasks.map((task) => (
                <div key={task.taskId} className="flex items-center gap-2.5 rounded-md border border-border bg-surface-2 px-3 py-2">
                  {task.status === "done" && <CircleCheck className="h-4 w-4 shrink-0 text-success" />}
                  {task.status === "error" && <CircleX className="h-4 w-4 shrink-0 text-danger" />}
                  {task.status !== "done" && task.status !== "error" && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-text">{task.label}</div>
                    <div className={cn("truncate text-[12px]", task.status === "error" ? "text-danger" : "text-text-2")}>{task.message ?? STATUS_LABEL[task.status]}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
