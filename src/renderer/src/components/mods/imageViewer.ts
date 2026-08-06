import { Fancybox } from "@fancyapps/ui/dist/fancybox/fancybox"

/**
 * The minimum needed to scroll/flash an option's row - locate() in ModSettingsDrawer.tsx only ever
 * reads these, never the image, so this is what a "Locate" button can pass even for an option with
 * no image (see SelectGroupSection's inline Locate button).
 */
export interface LocateTarget {
  key: string
  section: { type: "checkbox" } | { type: "group"; name: string }
  rowIndex: number // index within that section's *unfiltered* source array
}

/** A LocateTarget that's also viewable - what actually goes into a Fancybox gallery. */
export interface PreviewableOption extends LocateTarget {
  name: string
  image: string
}

/** Lucide's "locate" icon paths, inlined so the viewer's own Locate button matches the one used
 * elsewhere in the app (ModSettingsDrawer.tsx) - fancybox.css strokes/sizes any <svg> inside a
 * ".f-button" automatically, so no width/height/stroke attributes are needed here. */
const LOCATE_ICON_PATHS =
  '<line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="5"/><line x1="12" x2="12" y1="19" y2="22"/><circle cx="12" cy="12" r="7"/>'

/**
 * Opens a full-screen Fancybox viewer for `items`, starting at `startIndex`. A single-item `items`
 * array naturally shows no thumbnail filmstrip/prev-next chrome (Fancybox's Thumbs plugin only
 * activates once there are >=2 slides), which is what gives SelectGroupSection's "current option"
 * preview its single-image behavior for free.
 *
 * `CarouselSlide` (Fancybox's slide type) is a closed interface with no index signature, so it
 * won't carry an arbitrary extra property the way a loose JS object would - `bySrc` is how a
 * Fancybox slide gets correlated back to the `PreviewableOption` that produced it (every option's
 * `image` is unique within a single gallery call, so `src` doubles as that key).
 */
export function openImageViewer(
  items: PreviewableOption[],
  startIndex: number,
  opts: { onLocate?(item: PreviewableOption): void; onActiveChange?(key: string | null): void } = {}
): void {
  if (items.length === 0) return
  const bySrc = new Map(items.map((i) => [i.image, i]))

  function currentItem(): PreviewableOption | undefined {
    const src = Fancybox.getSlide()?.src
    return src ? bySrc.get(src) : undefined
  }

  Fancybox.show(
    items.map((i) => ({ src: i.image, caption: i.name })),
    {
      startIndex,
      Carousel: {
        Toolbar: {
          items: opts.onLocate
            ? {
                locate: {
                  tpl: `<button class="f-button" title="Locate in list"><svg>${LOCATE_ICON_PATHS}</svg></button>`,
                  click: () => {
                    const item = currentItem()
                    Fancybox.close()
                    if (item) opts.onLocate!(item)
                  }
                }
              }
            : {},
          // Only offered from a multi-item gallery (see callers) - locating only makes sense when
          // the user might have scrolled away from the option's row in the underlying list.
          display: { left: ["counter"], middle: [], right: opts.onLocate ? ["thumbs", "locate", "close"] : ["thumbs", "close"] }
        }
      },
      on: {
        "Carousel.change": () => opts.onActiveChange?.(currentItem()?.key ?? null),
        close: () => opts.onActiveChange?.(null)
      }
    }
  )
}

/** Force-closes any open viewer - used when the drawer itself closes or switches to a different mod, so a stale full-screen viewer can't outlive the option list it was opened from. */
export function closeImageViewer(): void {
  Fancybox.close()
}
