/**
 * A fixed, deterministic row height (rather than letting content/padding size it intrinsically) -
 * the virtualized list needs to know how tall an off-screen row would be without mounting it.
 * Keep this in sync with the rendered row's height if its markup changes.
 */
export const MOD_ROW_HEIGHT = 72
