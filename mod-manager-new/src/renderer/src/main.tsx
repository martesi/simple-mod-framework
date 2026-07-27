import React from "react"
import ReactDOM from "react-dom/client"
import { HashRouter } from "react-router-dom"

import { setSmfApi } from "@/lib/ipc"
import { createMockSmfApi } from "@/lib/ipc.mock"
import { TooltipProvider } from "@/components/ui/tooltip"
import App from "./App"

import "./styles/globals.css"

// Swap point: once LEI-134/LEI-133 land a real preload-exposed API, replace
// this with something like `setSmfApi(createElectronSmfApi(window.smf))`.
// Every screen reads the API through getSmfApi(), so nothing else changes.
setSmfApi(createMockSmfApi())

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </HashRouter>
  </React.StrictMode>
)
