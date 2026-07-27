import type * as React from "react"
import { Settings2, TriangleAlert, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { ModEntry } from "@/lib/manifest-types"
import { OptionType } from "@/lib/manifest-types"

export interface ModRowProps {
  mod: ModEntry
  enabled: boolean
  orderLabel: string
  dragging?: boolean
  removeBlocked: boolean
  onToggle(): void
  onOpenSettings(): void
  onRemove(): void
  onUpdateOutdated(): void
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>
  style?: React.CSSProperties
  setNodeRef?: (node: HTMLElement | null) => void
}

export function ModRow({ mod, enabled, orderLabel, dragging, removeBlocked, onToggle, onOpenSettings, onRemove, onUpdateOutdated, dragHandleProps, style, setNodeRef }: ModRowProps) {
  const name = mod.isFrameworkMod ? mod.manifest!.name : mod.rpkgModName!
  const description = mod.isFrameworkMod ? mod.manifest!.description : "RPKG-only mod"
  const author = mod.isFrameworkMod ? mod.manifest!.authors.join(", ") : ""
  const hasOptions = !!mod.manifest?.options?.some((o) => o.type !== OptionType.conditional)

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("flex items-center gap-3.5 border-b border-border px-[18px] py-4 last:border-b-0", dragging && "bg-surface-hover opacity-50")}
    >
      <div {...dragHandleProps} className="flex h-4 w-2.5 shrink-0 cursor-grab flex-wrap content-between gap-[2px] text-text-3 active:cursor-grabbing">
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} className="h-[3px] w-[3px] rounded-full bg-text-3" />
        ))}
      </div>

      <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-[11px] font-bold text-text-2" style={{ visibility: enabled ? "visible" : "hidden" }}>
        {orderLabel}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className={cn("truncate text-[14px] font-semibold", enabled ? "text-text" : "text-text-2")}>{name}</div>
          <Badge>{mod.isFrameworkMod ? "Framework" : "RPKG"}</Badge>
          {hasOptions && <Badge>Options</Badge>}
          {mod.outdated && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={onUpdateOutdated}>
                  <Badge variant="warning" className="cursor-pointer gap-1">
                    <TriangleAlert className="h-3 w-3" /> Outdated · Update
                  </Badge>
                </button>
              </TooltipTrigger>
              <TooltipContent>Built for an older framework version — click to update it</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="truncate text-[12.5px] text-text-2">{author ? `${author} — ${description}` : description}</div>
      </div>

      {hasOptions && (
        <Button variant="ghost" size="icon" title="Mod settings" onClick={onOpenSettings}>
          <Settings2 className="h-[15px] w-[15px] text-text-2" />
        </Button>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="ghost" size="icon" disabled={removeBlocked} title={removeBlocked ? "Can't remove while a deploy is running" : "Remove mod"} onClick={onRemove}>
              <X className="h-[15px] w-[15px] text-text-2" />
            </Button>
          </span>
        </TooltipTrigger>
        {removeBlocked && <TooltipContent>A deploy is running — mods can't be removed until it finishes.</TooltipContent>}
      </Tooltip>

      <Switch checked={enabled} onCheckedChange={onToggle} />
    </div>
  )
}
