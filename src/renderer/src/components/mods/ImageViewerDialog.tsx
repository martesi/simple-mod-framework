import { useEffect } from "react"
import { ChevronLeft, ChevronRight, Locate, X } from "lucide-react"
import { Trans, useLingui } from "@lingui/react/macro"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

export interface PreviewableOption {
  key: string
  name: string
  image: string
  /** Which list this option lives in, so "Locate" (see ModSettingsDrawer.tsx) knows which section to scroll. */
  section: { type: "checkbox" } | { type: "group"; name: string }
  /** Index within that section's *unfiltered* source array - only valid once that list's own search filter is cleared. */
  rowIndex: number
}

/**
 * Full-screen viewer for an option thumbnail - opened by clicking any PreviewThumb in
 * ModSettingsDrawer.tsx. Replaces the old position-anchored floating popover (which tracked a
 * click's `getBoundingClientRect()` and crashed once React's setState updater ran after the native
 * event had already finished dispatching - see ModSettingsDrawer.tsx's git history). A full-screen
 * Dialog needs no click coordinates at all, so that whole class of bug goes away rather than being
 * patched around.
 *
 * Built on the existing shadcn/Base UI Dialog primitive already used elsewhere in this app (the
 * "Delete mod" confirmation) - no new dependency.
 */
export function ImageViewerDialog({
  items,
  index,
  onIndexChange,
  onClose,
  onLocate
}: {
  items: PreviewableOption[]
  index: number | null
  onIndexChange(index: number): void
  onClose(): void
  /** Closes this viewer and scrolls/flashes the option's row in the underlying drawer list - see ModSettingsDrawer.tsx's `locate()`. */
  onLocate(item: PreviewableOption): void
}) {
  const { t } = useLingui()
  const open = index !== null
  const current = index !== null ? items[index] : null
  const hasMultiple = items.length > 1

  function goPrev() {
    if (index === null) return
    onIndexChange((index - 1 + items.length) % items.length)
  }

  function goNext() {
    if (index === null) return
    onIndexChange((index + 1) % items.length)
  }

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") goPrev()
      else if (e.key === "ArrowRight") goNext()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index, items.length])

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent hideClose className="flex h-[92vh] w-[92vw] max-w-none items-center justify-center border-none bg-black/90 p-0 shadow-none">
        {current && (
          <>
            <button type="button" onClick={onClose} title={t`Close (Esc)`} className="absolute right-5 top-5 rounded-full bg-white/10 p-2 text-white/80 hover:bg-white/20 hover:text-white">
              <X className="h-4 w-4" />
            </button>

            {hasMultiple && (
              <>
                <button
                  type="button"
                  onClick={goPrev}
                  title={t`Previous (←)`}
                  className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white/80 hover:bg-white/20 hover:text-white"
                >
                  <ChevronLeft className="h-6 w-6" />
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  title={t`Next (→)`}
                  className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white/80 hover:bg-white/20 hover:text-white"
                >
                  <ChevronRight className="h-6 w-6" />
                </button>
              </>
            )}

            <div className="flex max-h-full max-w-full flex-col items-center gap-3 p-6">
              <img src={current.image} alt={current.name} className="max-h-[80vh] max-w-[85vw] rounded-md object-contain" />
              <div className="text-[13px] text-white/80">
                {current.name}
                {hasMultiple && (
                  <span className="text-white/50">
                    {" "}
                    <Trans>
                      · {index! + 1} / {items.length}
                    </Trans>
                  </span>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={() => onLocate(current)} className="gap-1.5 border-white/20 bg-white/10 text-white/80 hover:bg-white/20 hover:text-white">
                <Locate className="h-3.5 w-3.5" />
                <Trans>Locate in list</Trans>
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
