import { Trans, useLingui } from '@lingui/react/macro'
import { ExternalLink, Loader2, Settings2, TriangleAlert, X } from 'lucide-react'
import type * as React from 'react'
import { memo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { toHttpsUrl } from '@/lib/external-url'
import type { ModBuildInfo } from '@/lib/ipc'
import type { ModEntry } from '@/lib/manifest-types'
import { OptionType } from '@/lib/manifest-types'
import { cn } from '@/lib/utils'
import { MOD_ROW_HEIGHT } from './mod-layout'

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
  /** LEI-141's per-mod eager-build status - `undefined` for a mod that's never had a build recorded (RPKG-only mods, or one whose first build hasn't run yet). */
  buildStatus?: ModBuildInfo['status']
  buildError?: string
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>
  style?: React.CSSProperties
  setNodeRef?: (node: HTMLElement | null) => void
}

function ModRowImpl({
  mod,
  enabled,
  orderLabel,
  dragging,
  removeBlocked,
  onToggle,
  onOpenSettings,
  onRemove,
  buildStatus,
  buildError,
  dragHandleProps,
  style,
  setNodeRef,
}: ModRowProps) {
  const { t } = useLingui()
  const name = mod.isFrameworkMod ? mod.manifest?.name : mod.rpkgModName!
  const description = mod.isFrameworkMod ? mod.manifest?.description : t`RPKG-only mod`
  const author = mod.isFrameworkMod ? mod.manifest?.authors.join(', ') : ''
  const hasOptions = !!mod.manifest?.options?.some((o) => o.type !== OptionType.conditional)
  // Revalidate at the UI boundary too. Cached manifests can outlive an app upgrade, and this keeps
  // the click handler safe even if a future data source bypasses ModIndex's normalization.
  const externalUrl = toHttpsUrl(mod.manifest?.url)

  return (
    <div
      ref={setNodeRef}
      style={{ height: MOD_ROW_HEIGHT, boxSizing: 'border-box', ...style }}
      className={cn(
        'flex items-center gap-3.5 border-b border-border px-[18px] last:border-b-0',
        dragging && 'bg-surface-hover opacity-50'
      )}
    >
      <div
        {...dragHandleProps}
        className="flex h-4 w-2.5 shrink-0 cursor-grab flex-wrap content-between gap-[2px] text-text-3 active:cursor-grabbing"
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} className="h-[3px] w-[3px] rounded-full bg-text-3" />
        ))}
      </div>

      <div
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-[11px] font-bold text-text-2"
        style={{ visibility: enabled ? 'visible' : 'hidden' }}
      >
        {orderLabel}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'truncate text-[14px] font-semibold',
              enabled ? 'text-text' : 'text-text-2'
            )}
          >
            {name}
          </div>
          <Badge>{mod.isFrameworkMod ? <Trans>Framework</Trans> : <Trans>RPKG</Trans>}</Badge>
          {hasOptions && (
            <Badge>
              <Trans>Options</Trans>
            </Badge>
          )}
          {buildStatus === 'building' && (
            <Badge variant="accent" className="gap-1">
              <Loader2 className="h-2.5 w-2.5 animate-spin" /> <Trans>Building…</Trans>
            </Badge>
          )}
          {buildStatus === 'failed' && (
            <Tooltip>
              <TooltipTrigger render={<span />}>
                <Badge variant="warning" className="gap-1">
                  <TriangleAlert className="h-3 w-3" /> <Trans>Build failed</Trans>
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                {buildError ||
                  t`Something went wrong building this mod's cache — check the logs, or try Settings' Rebuild cache database.`}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="truncate text-[12.5px] text-text-2">
          {author ? `${author} — ${description}` : description}
        </div>
      </div>

      {hasOptions && (
        <Button
          variant="ghost"
          size="icon"
          title={t`Mod settings`}
          onClick={() => onOpenSettings(mod.id)}
        >
          <Settings2 className="h-[15px] w-[15px] text-text-2" />
        </Button>
      )}

      {externalUrl && (
        <Button
          variant="ghost"
          size="icon"
          title={t`Open mod page in browser`}
          onClick={() => window.open(externalUrl, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink className="h-[15px] w-[15px] text-text-2" />
        </Button>
      )}

      <Tooltip>
        {/* render={<span />} swaps out Trigger's default button element for a
            span - same reason the old Radix asChild version wrapped the
            (possibly disabled) Button in a span: a disabled real <button>
            can swallow the hover/focus events a tooltip trigger needs. */}
        <TooltipTrigger render={<span />}>
          <Button
            variant="ghost"
            size="icon"
            disabled={removeBlocked}
            title={removeBlocked ? t`Can't remove while a deploy is running` : t`Remove mod`}
            onClick={() => onRemove(mod)}
          >
            <X className="h-[15px] w-[15px] text-text-2" />
          </Button>
        </TooltipTrigger>
        {removeBlocked && (
          <TooltipContent>
            <Trans>A deploy is running — mods can't be removed until it finishes.</Trans>
          </TooltipContent>
        )}
      </Tooltip>

      <Switch
        checked={enabled}
        disabled={mod.isFrameworkMod && mod.valid === false}
        onCheckedChange={() => onToggle(mod.id)}
      />
    </div>
  )
}

/** Memoized so a state change elsewhere in ModsScreen (opening the settings drawer, a remove
 * confirmation dialog, search text) doesn't force *every* row to re-render - each one also mounts
 * dnd-kit's useSortable() via SortableModRow.tsx, which isn't free with many mods installed. Only
 * effective because ModsScreen.tsx passes stable store-action references as the callback props
 * (see ModRowProps' doc comment above) instead of new closures every render. */
export const ModRow = memo(ModRowImpl)
