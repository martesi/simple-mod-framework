import * as React from "react"
import { memo } from "react"
import { Loader2, Settings2, TriangleAlert, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { ModEntry } from "@/lib/manifest-types"
import { OptionType } from "@/lib/manifest-types"
import type { ModBuildInfo } from "@/lib/ipc"

/**
 * A fixed, deterministic row height (rather than letting content/padding size it intrinsically) -
 * ModsScreen.tsx's virtualized list needs to know exactly how tall an off-screen row *would* be to
 * compute the visible scroll range and size the spacer divs above/below it without ever having to
 * mount and measure one. Keep this in sync with the actual rendered height below (px-[18px], the
 * two-line name/description block, items-center) if that markup changes.
 */
export const MOD_ROW_HEIGHT = 72

export interface ModRowProps {
  mod: ModEntry
  enabled: boolean
  orderLabel: string
  dragging?: boolean
  removeBlocked: boolean
  /**
   * Callbacks take the mod's id (or the mod itself, for onRemove's confirm dialog) rather than
   * being pre-bound per row - this lets ModsScreen.tsx pass the same store-action function
   * reference (e.g. `toggleMod` itself) for every row instead of a fresh arrow closure per row per
   * render. That's what makes memo() below actually able to bail out: with a new closure identity
   * every render, shallow prop comparison would never match and every row would re-render anyway
   * whenever ModsScreen re-rendered for any reason (e.g. opening the settings drawer) - expensive
   * with many mods, since each row also mounts dnd-kit's useSortable() (see SortableModRow.tsx).
   */
  onToggle(id: string): void
  onOpenSettings(id: string): void
  onRemove(mod: ModEntry): void
  onUpdateOutdated(id: string): void
  /** LEI-141's per-mod eager-build status - `undefined` for a mod that's never had a build recorded (RPKG-only mods, or one whose first build hasn't run yet). */
  buildStatus?: ModBuildInfo["status"]
  buildError?: string
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>
  style?: React.CSSProperties
  setNodeRef?: (node: HTMLElement | null) => void
}

function ModRowImpl({ mod, enabled, orderLabel, dragging, removeBlocked, onToggle, onOpenSettings, onRemove, onUpdateOutdated, buildStatus, buildError, dragHandleProps, style, setNodeRef }: ModRowProps) {
  const name = mod.isFrameworkMod ? mod.manifest!.name : mod.rpkgModName!
  const description = mod.isFrameworkMod ? mod.manifest!.description : "RPKG-only mod"
  const author = mod.isFrameworkMod ? mod.manifest!.authors.join(", ") : ""
  const hasOptions = !!mod.manifest?.options?.some((o) => o.type !== OptionType.conditional)

  return (
    <div
      ref={setNodeRef}
      style={{ height: MOD_ROW_HEIGHT, boxSizing: "border-box", ...style }}
      className={cn("flex items-center gap-3.5 border-b border-border px-[18px] last:border-b-0", dragging && "bg-surface-hover opacity-50")}
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
              {/* Base UI's Trigger already renders a <button> by default, so
                  the Badge just becomes its (clickable) content - no need to
                  nest another real <button> inside it. */}
              <TooltipTrigger onClick={() => onUpdateOutdated(mod.id)} className="appearance-none border-0 bg-transparent p-0">
                <Badge variant="warning" className="cursor-pointer gap-1">
                  <TriangleAlert className="h-3 w-3" /> Outdated · Update
                </Badge>
              </TooltipTrigger>
              <TooltipContent>Built for an older framework version — click to update it</TooltipContent>
            </Tooltip>
          )}
          {buildStatus === "building" && (
            <Badge variant="accent" className="gap-1">
              <Loader2 className="h-2.5 w-2.5 animate-spin" /> Building…
            </Badge>
          )}
          {buildStatus === "failed" && (
            <Tooltip>
              <TooltipTrigger render={<span />}>
                <Badge variant="warning" className="gap-1">
                  <TriangleAlert className="h-3 w-3" /> Build failed
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{buildError || "Something went wrong building this mod's cache — check the logs, or try Settings' Rebuild cache database."}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="truncate text-[12.5px] text-text-2">{author ? `${author} — ${description}` : description}</div>
      </div>

      {hasOptions && (
        <Button variant="ghost" size="icon" title="Mod settings" onClick={() => onOpenSettings(mod.id)}>
          <Settings2 className="h-[15px] w-[15px] text-text-2" />
        </Button>
      )}

      <Tooltip>
        {/* render={<span />} swaps out Trigger's default button element for a
            span - same reason the old Radix asChild version wrapped the
            (possibly disabled) Button in a span: a disabled real <button>
            can swallow the hover/focus events a tooltip trigger needs. */}
        <TooltipTrigger render={<span />}>
          <Button variant="ghost" size="icon" disabled={removeBlocked} title={removeBlocked ? "Can't remove while a deploy is running" : "Remove mod"} onClick={() => onRemove(mod)}>
            <X className="h-[15px] w-[15px] text-text-2" />
          </Button>
        </TooltipTrigger>
        {removeBlocked && <TooltipContent>A deploy is running — mods can't be removed until it finishes.</TooltipContent>}
      </Tooltip>

      <Switch checked={enabled} onCheckedChange={() => onToggle(mod.id)} />
    </div>
  )
}

/** Memoized so a state change elsewhere in ModsScreen (opening the settings drawer, a remove
 * confirmation dialog, search text) doesn't force *every* row to re-render - each one also mounts
 * dnd-kit's useSortable() via SortableModRow.tsx, which isn't free with many mods installed. Only
 * effective because ModsScreen.tsx passes stable store-action references as the callback props
 * (see ModRowProps' doc comment above) instead of new closures every render. */
export const ModRow = memo(ModRowImpl)
