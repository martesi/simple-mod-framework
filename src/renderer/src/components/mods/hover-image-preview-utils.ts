export const PREVIEW_SIZE = 240
const EDGE_MARGIN = 16

/** Clamps a hover popup's top-left so its square stays fully on-screen. */
export function clampHoverPosition(clientX: number, clientY: number): { x: number; y: number } {
  const x =
    clientX + PREVIEW_SIZE + EDGE_MARGIN * 2 > window.innerWidth
      ? clientX - PREVIEW_SIZE - EDGE_MARGIN
      : clientX + EDGE_MARGIN
  const y = Math.min(clientY, window.innerHeight - PREVIEW_SIZE - EDGE_MARGIN)
  return { x, y }
}
