import React from "react"
import ReactDOM from "react-dom/client"
import { HashRouter } from "react-router-dom"

import { setSmfApi } from "@/lib/ipc"
import { createMockSmfApi } from "@/lib/ipc.mock"
import { createElectronSmfApi } from "@/lib/ipc.electron"
import { TooltipProvider } from "@/components/ui/tooltip"
import App from "./App"

import "./styles/globals.css"

// LEI-134 landed the real preload-exposed API (window.smf, see
// preload/index.ts) - use it whenever it's present. The mock stays as a
// fallback for running the renderer outside a real Electron shell (e.g. a
// plain `vite` browser preview), so this file is still the *only* place a
// screen-visible behavior change happens; every screen reads the API
// through getSmfApi(), so nothing else changes either way.
setSmfApi(window.smf ? createElectronSmfApi() : createMockSmfApi())

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </HashRouter>
  </React.StrictMode>
)
