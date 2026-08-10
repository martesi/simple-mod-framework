/// <reference types="vite/client" />

// @lingui/vite-plugin compiles .po catalogs on the fly (see electron.vite.config.ts and i18n.ts) -
// TypeScript has no built-in notion of a .po module, so this teaches it the shape the plugin
// actually produces at runtime.
declare module '*.po' {
  import type { Messages } from '@lingui/core'

  export const messages: Messages
}
