import { createPortal } from "react-dom"

const PREVIEW_SIZE = 240
const EDGE_MARGIN = 16

/**
 * Larger, uncropped look at a mod-option thumbnail on hover - see PreviewThumb in
 * ModSettingsDrawer.tsx for the trigger (a short hover delay before this mounts). Portals to
 * `document.body` because thumbnails live inside `overflow-y-auto` virtualized list containers -
 * a non-portaled popup would get clipped by those containers' scroll bounds.
 */
export function HoverImagePreview({ image, x, y }: { image: string; x: number; y: number }) {
  return createPortal(
    <div className="pointer-events-none fixed z-[95] animate-fade-in" style={{ left: x, top: y }}>
      <img src={image} alt="" className="rounded-md border border-border bg-surface-2 object-contain shadow-md" style={{ height: PREVIEW_SIZE, width: PREVIEW_SIZE }} />
    </div>,
    document.body
  )
}

/** Clamps a hover popup's top-left so `PREVIEW_SIZE`x`PREVIEW_SIZE` box stays fully on-screen, flipping to the cursor's left when it would overflow the right edge. */
export function clampHoverPosition(clientX: number, clientY: number): { x: number; y: number } {
  const x = clientX + PREVIEW_SIZE + EDGE_MARGIN * 2 > window.innerWidth ? clientX - PREVIEW_SIZE - EDGE_MARGIN : clientX + EDGE_MARGIN
  const y = Math.min(clientY, window.innerHeight - PREVIEW_SIZE - EDGE_MARGIN)
  return { x, y }
}
