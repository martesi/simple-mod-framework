import { FolderOpen } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * A path text field + "Browse" button, shared by SettingsScreen's Paths card
 * and SetupWizard's per-path steps. There is no real fs access in this UI-only
 * build (see ipc.ts) - Browse is intentionally a no-op, same as `noop` in
 * new-ui/Mod Manager.dc.html, until LEI-133 wires up a real directory picker.
 */
export function PathInputRow({
  value,
  placeholder,
  onChange,
  size = "default"
}: {
  value: string
  placeholder: string
  onChange(value: string): void
  size?: "default" | "lg"
}) {
  return (
    <div className="flex gap-2">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "flex-1 rounded-md border border-border bg-surface-2 font-mono text-[13px] text-text outline-none placeholder:text-text-3",
          size === "lg" ? "px-3 py-2.5" : "px-3 py-[9px]"
        )}
      />
      <button
        type="button"
        title="Browse"
        onClick={() => {}}
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-text-2 hover:bg-surface-hover",
          size === "lg" ? "h-[38px] w-[38px]" : "h-9 w-9"
        )}
      >
        <FolderOpen className="h-[14px] w-[14px]" />
      </button>
    </div>
  )
}
