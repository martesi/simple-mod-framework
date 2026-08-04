import { useMemo, useState } from "react"
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable"
import { Loader2, Plus, RefreshCw, Rocket, Search } from "lucide-react"
import { toast } from "sonner"
import { Trans, useLingui } from "@lingui/react/macro"

import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { useAppStore } from "@/store/app-store"
import { useVirtualList } from "@/lib/useVirtualList"
import type { ModEntry } from "@/lib/manifest-types"

import { SortableModRow } from "./SortableModRow"
import { MOD_ROW_HEIGHT } from "./ModRow"
import { AddModDialog } from "./AddModDialog"
import { ModSettingsDrawer } from "./ModSettingsDrawer"

function modLabel(mod: ModEntry) {
  return mod.isFrameworkMod ? `${mod.manifest!.name} ${mod.manifest!.description}` : mod.rpkgModName!
}

/**
 * Rows rendered above/below the visible viewport, on top of whatever's actually in view. Generous
 * on purpose: dnd-kit needs a row physically mounted in the DOM to compute drag collision against
 * it, and a user can only ever hover the mouse over something on-screen, so this just needs to
 * comfortably cover "on-screen plus a bit of headroom for a fast drag/scroll" - not the whole list.
 */
const OVERSCAN = 10

export function ModsScreen() {
  const { t } = useLingui()
  const mods = useAppStore((s) => s.mods)
  const modsLoading = useAppStore((s) => s.modsLoading)
  const cacheProgress = useAppStore((s) => s.cacheProgress)
  const buildStatuses = useAppStore((s) => s.buildStatuses)
  const config = useAppStore((s) => s.config)
  const search = useAppStore((s) => s.search)
  const setSearch = useAppStore((s) => s.setSearch)
  const toggleMod = useAppStore((s) => s.toggleMod)
  const reorderMods = useAppStore((s) => s.reorderMods)
  const removeMod = useAppStore((s) => s.removeMod)
  const rebuildIndex = useAppStore((s) => s.rebuildIndex)
  const rebuildingIndex = useAppStore((s) => s.rebuildingIndex)
  const startDeploy = useAppStore((s) => s.startDeploy)
  const deploy = useAppStore((s) => s.deploy)
  // Lifted to the store (see app-store.ts's addDialogOpen/openAddDialog/closeAddDialog) so the
  // whole-window drop handler in App.tsx can pop this dialog open too, not just this screen's own
  // "Add a mod" button - a drop landing anywhere in the app needs somewhere to show its progress.
  const addOpen = useAppStore((s) => s.addDialogOpen)
  const openAddDialog = useAppStore((s) => s.openAddDialog)
  const closeAddDialog = useAppStore((s) => s.closeAddDialog)

  const [settingsModId, setSettingsModId] = useState<string | null>(null)
  const [removeCandidate, setRemoveCandidate] = useState<ModEntry | null>(null)

  const deployActive = !!deploy.snapshot && !(deploy.progress?.done ?? false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const orderIndex = useMemo(() => {
    const order = config?.modOrder ?? []
    const map = new Map(order.map((id, i) => [id, i]))
    return map
  }, [config])

  // An empty or whitespace-only query means "no filter" - trim before
  // comparing so a stray space doesn't hide every mod (a blank string is a
  // substring of everything, but "  " usually isn't).
  const q = search.trim().toLowerCase()

  const filtered = useMemo(() => {
    return mods.filter((m) => !q || modLabel(m).toLowerCase().includes(q)).sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0))
  }, [mods, q, orderIndex])

  const enabledIds = config?.loadOrder ?? []
  const settingsMod = mods.find((m) => m.id === settingsModId) ?? null

  // Which slice of `filtered` falls within (an overscanned margin around) the currently-visible
  // scroll range - see useVirtualList.ts. `SortableContext` below still gets the *full* ordered id
  // list (dnd-kit needs that for correct index/collision math), but only `windowed` actually mounts
  // a <SortableModRow>.
  const { containerRef: listRef, windowed, topSpacer, bottomSpacer } = useVirtualList(filtered, MOD_ROW_HEIGHT, OVERSCAN)

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id || !config) return

    const fullOrder = config.modOrder.length ? config.modOrder : mods.map((m) => m.id)
    const oldIndex = fullOrder.indexOf(String(active.id))
    const newIndex = fullOrder.indexOf(String(over.id))
    if (oldIndex === -1 || newIndex === -1) return

    reorderMods(arrayMove(fullOrder, oldIndex, newIndex))
  }

  async function confirmRemove() {
    if (!removeCandidate) return
    const result = await removeMod(removeCandidate.id)
    if (!result.ok) {
      toast.error(result.reason ?? t`Couldn't remove the mod.`)
    }
    setRemoveCandidate(null)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1.5 flex items-center gap-4">
        <h1 className="flex-1 text-2xl font-bold">
          <Trans>Mods</Trans>
        </h1>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t`Filter mods…`} className="w-60 pl-8" />
        </div>
        {config?.developerMode && (
          <Button variant="outline" title={t`Re-scan the Mods folder and re-read every manifest from disk`} disabled={rebuildingIndex} onClick={() => rebuildIndex()}>
            {rebuildingIndex ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <Trans>Rebuild cache</Trans>
          </Button>
        )}
        <Button variant="outline" onClick={openAddDialog}>
          <Plus className="h-4 w-4" /> <Trans>Add a mod</Trans>
        </Button>
        <Button onClick={startDeploy} disabled={deployActive}>
          <Rocket className="h-4 w-4" /> <Trans>Apply changes</Trans>
        </Button>
      </div>

      {modsLoading && (
        <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-border bg-surface px-4 py-3 text-[13px] text-text-2">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          {cacheProgress ? (
            <Trans>
              Building mod cache — scanned {cacheProgress.scanned} of {cacheProgress.total} mods…
            </Trans>
          ) : (
            <Trans>Building mod cache — this can take a moment the first time, or after switching mod folders…</Trans>
          )}
        </div>
      )}

      <div className="mb-5 text-[13px] text-text-2">
        <Trans>
          {enabledIds.length} enabled · {mods.length} total
        </Trans>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
        {!modsLoading && filtered.length === 0 && q && (
          <div className="px-[18px] py-10 text-center text-[13px] text-text-3">
            <Trans>No mods match "{search.trim()}".</Trans>
          </div>
        )}

        <div ref={listRef} className="h-full overflow-y-auto">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={filtered.map((m) => m.id)} strategy={verticalListSortingStrategy}>
              {topSpacer > 0 && <div style={{ height: topSpacer }} />}
              {windowed.map((mod) => {
                const enabled = enabledIds.includes(mod.id)
                const enabledIndex = enabledIds.indexOf(mod.id)
                const build = buildStatuses[mod.id]
                return (
                  <SortableModRow
                    key={mod.id}
                    id={mod.id}
                    mod={mod}
                    enabled={enabled}
                    orderLabel={enabledIndex >= 0 ? String(enabledIndex + 1) : ""}
                    removeBlocked={deployActive}
                    dragDisabled={!!q}
                    buildStatus={build?.status}
                    buildError={build?.error}
                    // Stable store-action/setState references, not per-row closures - see
                    // ModRow.tsx's doc comment on why that's what lets memo() actually skip
                    // re-rendering rows unaffected by whatever caused this component to re-render.
                    onToggle={toggleMod}
                    onOpenSettings={setSettingsModId}
                    onRemove={setRemoveCandidate}
                  />
                )
              })}
              {bottomSpacer > 0 && <div style={{ height: bottomSpacer }} />}
            </SortableContext>
          </DndContext>
        </div>
      </div>

      <AddModDialog open={addOpen} onOpenChange={(open) => (open ? openAddDialog() : closeAddDialog())} />
      <ModSettingsDrawer mod={settingsMod} onClose={() => setSettingsModId(null)} />

      <Dialog open={!!removeCandidate} onOpenChange={(open) => !open && setRemoveCandidate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Delete mod</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Are you sure you want to permanently remove{" "}
                <i>{removeCandidate?.isFrameworkMod ? removeCandidate.manifest?.name : removeCandidate?.rpkgModName}</i>? You can't undo this.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRemoveCandidate(null)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button variant="destructive" onClick={confirmRemove}>
              <Trans>Delete the mod</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
