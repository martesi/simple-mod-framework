import type { Item } from 'klaw'
import klaw from 'klaw'

export type { Item as WalkItem }

/**
 * Async replacement for klaw-sync's synchronous recursive directory walk - klaw-sync blocks the
 * event loop for the entire walk (every stat, for every file, in one synchronous call); `klaw` is
 * the same author's stream-based, non-blocking equivalent (a Node `Readable` in object mode that's
 * also directly `AsyncIterable`).
 *
 * Every call site here already expects an in-memory array of `{path, stats}` items the way
 * klaw-sync returned it, rather than a stream to consume incrementally - collecting the walk into
 * an array up front (via `for await` over the stream's own async iterator) keeps every caller's
 * `.filter()`/`.map()`/`.some()` chain unchanged while still making the walk itself non-blocking.
 *
 * This file deliberately has no dependency on `./core-singleton`/`./utils` (which itself imports
 * from `./smf-rust`, one of this helper's own consumers) - keeping it a standalone leaf module
 * avoids a require cycle between `smf-rust.ts` and whatever module `walk()` would otherwise have
 * needed to live in.
 */
export async function walk(dir: string): Promise<Item[]> {
  const items: Item[] = []
  for await (const item of klaw(dir)) {
    items.push(item)
  }
  return items
}
