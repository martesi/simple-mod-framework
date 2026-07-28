import { useMemo, useState } from "react"
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable"
import { Plus, Rocket, Search } from "lucide-react"
import { toast } from "sonner"

import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { useAppStore } from "@/store/app-store"
import type { ModEntry } from "@/lib/manifest-types"

import { SortableModRow } from "./SortableModRow"
import { AddModDialog } from "./AddModDialog"
import { ModSettingsDrawer } from "./ModSettingsDrawer"

function modLabel(mod: ModEntry) {
  return mod.isFrameworkMod ? `${mod.manifest!.name} ${mod.manifest!.description}` : mod.rpkgModName!
}

export function ModsScreen() {
  const mods = useAppStore((s) => s.mods)
  const config = useAppStore((s) => s.config)
  const search = useAppStore((s) => s.search)
  const setSearch = useAppStore((s) => s.setSearch)
  const toggleMod = useAppStore((s) => s.toggleMod)
  const reorderMods = useAppStore((s) => s.reorderMods)
  const removeMod = useAppStore((s) => s.removeMod)
  const updateOutdated = useAppStore((s) => s.updateOutdated)
  const startDeploy = useAppStore((s) => s.startDeploy)
  const deploy = useAppStore((s) => s.deploy)

  const [addOpen, setAddOpen] = useState(false)
  const [settingsModId, setSettingsModId] = useState<string | null>(null)
  const [removeCandidate, setRemoveCandidate] = useState<ModEntry | null>(null)

  const deployActive = !!deploy.snapshot && !(deploy.progress?.done ?? false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const orderIndex = useMemo(() => {
    const order = config?.modOrder ?? []
    const map = new Map(order.map((id, i) => [id, i]))
    return map
  }, [config])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return mods.filter((m) => modLabel(m).toLowerCase().includes(q)).sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0))
  }, [mods, search, orderIndex])

  const enabledIds = config?.loadOrder ?? []
  const settingsMod = mods.find((m) => m.id === settingsModId) ?? null

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
      toast.error(result.reason ?? "Couldn't remove the mod.")
    }
    setRemoveCandidate(null)
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-4">
        <h1 className="flex-1 text-2xl font-bold">Mods</h1>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter mods…" className="w-60 pl-8" />
        </div>
        <Button variant="outline" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" /> Add a mod
        </Button>
        <Button onClick={startDeploy} disabled={deployActive}>
          <Rocket className="h-4 w-4" /> Apply changes
        </Button>
      </div>

      <div className="mb-5 text-[13px] text-text-2">
        {enabledIds.length} enabled · {mods.length} total
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
        {filtered.length === 0 && <div className="px-[18px] py-10 text-center text-[13px] text-text-3">No mods match "{search}".</div>}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={filtered.map((m) => m.id)} strategy={verticalListSortingStrategy}>
            {filtered.map((mod) => {
              const enabled = enabledIds.includes(mod.id)
              const enabledIndex = enabledIds.indexOf(mod.id)
              return (
                <SortableModRow
                  key={mod.id}
                  id={mod.id}
                  mod={mod}
                  enabled={enabled}
                  orderLabel={enabledIndex >= 0 ? String(enabledIndex + 1) : ""}
                  removeBlocked={deployActive}
                  dragDisabled={!!search}
                  onToggle={() => toggleMod(mod.id)}
                  onOpenSettings={() => setSettingsModId(mod.id)}
                  onRemove={() => setRemoveCandidate(mod)}
                  onUpdateOutdated={() => updateOutdated(mod.id)}
                />
              )
            })}
          </SortableContext>
        </DndContext>
      </div>

      <AddModDialog open={addOpen} onOpenChange={setAddOpen} />
      <ModSettingsDrawer mod={settingsMod} onClose={() => setSettingsModId(null)} />

      <Dialog open={!!removeCandidate} onOpenChange={(open) => !open && setRemoveCandidate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete mod</DialogTitle>
            <DialogDescription>
              Are you sure you want to permanently remove{" "}
              <i>{removeCandidate?.isFrameworkMod ? removeCandidate.manifest?.name : removeCandidate?.rpkgModName}</i>? You can't undo this.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRemoveCandidate(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmRemove}>
              Delete the mod
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
