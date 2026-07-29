import { useEffect, useRef, useState, type RefObject } from "react"

export interface VirtualWindow<T> {
  /** Attach to whichever element actually scrolls - its measured `scrollTop`/`clientHeight` drive everything below. */
  containerRef: RefObject<HTMLDivElement | null>
  /** The slice of `items` that should actually be mounted right now - everything else is represented only by the spacers below. */
  windowed: T[]
  /** Height (px) of the empty spacer standing in for every skipped row *above* `windowed`. */
  topSpacer: number
  /** Height (px) of the empty spacer standing in for every skipped row *below* `windowed`. */
  bottomSpacer: number
}

/**
 * Hand-rolled virtualization - no dependency added (see ModsScreen.tsx's original doc comment,
 * which this was pulled out of): only mounts the slice of `items` that falls within (an
 * overscanned margin around) `containerRef`'s current scroll position, instead of every single
 * item regardless of whether it's ever actually visible.
 *
 * Originally lived only in ModsScreen.tsx for the mod list. Pulled out here because
 * ModSettingsDrawer.tsx's checkbox list and each select group's option list hit the exact same
 * problem, just scoped to a single mod's manifest instead of the whole install: a manifest that
 * declares a genuinely large option list (thousands of checkboxes, or one select group with
 * thousands of choices) mounted every single one regardless of scroll position, because nothing
 * in that file was windowing them the way the mod list already was - full DOM cost (labels,
 * checkboxes/radios, tooltip triggers, and for image options a thumbnail `<img>` and preview
 * button) for every option, all in one React commit, the instant the drawer opened. That's a
 * synchronous multi-thousand-node mount, which is exactly what a multi-second Interaction to Next
 * Paint on a single click looks like - not a main-process/IPC problem at all this time, just an
 * un-windowed list, the same class of bug the mod list already had before ModsScreen.tsx's own
 * fix.
 *
 * `rowHeight` must be a single fixed height every item is willing to render at regardless of its
 * own content (see MOD_ROW_HEIGHT's doc comment in ModRow.tsx for the same constraint) - variable
 * per-row heights aren't supported by this simple version.
 */
export function useVirtualList<T>(items: T[], rowHeight: number, overscan = 10): VirtualWindow<T> {
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const update = () => setViewport({ scrollTop: el.scrollTop, height: el.clientHeight })
    update()

    el.addEventListener("scroll", update, { passive: true })
    const resizeObserver = new ResizeObserver(update)
    resizeObserver.observe(el)

    return () => {
      el.removeEventListener("scroll", update)
      resizeObserver.disconnect()
    }
    // Re-measure whenever the item count changes too - a shorter list can mean this container's
    // clientHeight itself changed shape/collapsed (e.g. content shrank below its max-height), which
    // ResizeObserver already catches, but re-running `update()` here as well covers the case where
    // the container's size didn't change but `scrollTop` needs re-clamping against a smaller total.
  }, [items.length])

  const total = items.length
  const startIndex = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - overscan)
  const visibleCount = Math.ceil(viewport.height / rowHeight) + overscan * 2
  const endIndex = Math.min(total, startIndex + visibleCount)

  return {
    containerRef,
    windowed: items.slice(startIndex, endIndex),
    topSpacer: startIndex * rowHeight,
    bottomSpacer: (total - endIndex) * rowHeight
  }
}
