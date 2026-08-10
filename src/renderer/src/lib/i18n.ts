import { i18n } from '@lingui/core'
import { messages } from '@/locales/en-US/messages.po'

// Only en-US ships right now (see lingui.config.js) - load/activate it eagerly here, as a side
// effect of importing this module, so every macro (t/Trans/useLingui) has a live locale before
// anything else in the renderer renders. Swapping locales later just needs another i18n.load()
// + i18n.activate() call (e.g. from Settings), not a change to this bootstrap.
i18n.load('en-US', messages)
i18n.activate('en-US')

export { i18n }
