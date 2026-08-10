import { createPortal } from 'react-dom'
import { PREVIEW_SIZE } from './hover-image-preview-utils'

/**
 * Larger, uncropped look at a mod-option thumbnail on hover - see PreviewThumb in
 * ModSettingsDrawer.tsx for the trigger (a short hover delay before this mounts). Portals to
 * `document.body` because thumbnails live inside `overflow-y-auto` virtualized list containers -
 * a non-portaled popup would get clipped by those containers' scroll bounds.
 */
export function HoverImagePreview({ image, x, y }: { image: string; x: number; y: number }) {
  return createPortal(
    <div className="pointer-events-none fixed z-[95] animate-fade-in" style={{ left: x, top: y }}>
      <img
        src={image}
        alt=""
        className="rounded-md border border-border bg-surface-2 object-contain shadow-md"
        style={{ height: PREVIEW_SIZE, width: PREVIEW_SIZE }}
      />
    </div>,
    document.body
  )
}
