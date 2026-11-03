// The ProSE tool the app runs (`tool_info`): asked once at start, for the rescoring card (whether it has
// ONNX Runtime for PeptDeep) and the search's problem line (a tool that cannot be found).

import { cpuCount, errorText, toolInfo, type ToolInfo } from '../desktop'

export const toolState = $state<{ status: 'loading' | 'ready' | 'failed'; info: ToolInfo | null; error: string | null }>({
  status: 'loading',
  info: null,
  error: null,
})

let asked: Promise<ToolInfo | null> | null = null

/** Asks the shim for the tool (once); resolves with it, or null if it cannot be found or run. */
export function loadTool(): Promise<ToolInfo | null> {
  asked ??= toolInfo().then(
    (info) => {
      Object.assign(toolState, { status: 'ready', info, error: null })
      return info
    },
    (e: unknown) => {
      Object.assign(toolState, { status: 'failed', info: null, error: errorText(e) })
      return null
    },
  )
  return asked
}

/** This computer's cores, the threads' default ("all"): from the shim (the webview caps its own count at 8). */
export const machine = $state<{ cores: number | null }>({ cores: null })

let coresAsked = false

/** Asks the shim for the cores (once); without the shim (a plain browser), the webview's count. */
export function loadCores(): void {
  if (coresAsked) return
  coresAsked = true
  cpuCount().then(
    (n) => (machine.cores = n),
    () => (machine.cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || null : null),
  )
}
