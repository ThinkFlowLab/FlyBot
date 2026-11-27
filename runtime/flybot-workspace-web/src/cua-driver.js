import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const binary = '/usr/local/bin/cua-driver'
const nativeRequire = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')

export function cuaAvailable() {
  try {
    accessSync(binary, constants.X_OK)
    return true
  } catch { return false }
}

function desktopError(status, message) {
  return Object.assign(new Error(message), {status})
}

const short = (value, length = 180) => typeof value === 'string' ? value.slice(0, length) : undefined

export function createCuaDriver(desktop) {
  let client
  let transport
  let closing
  const lifetime = new AbortController()
  let inspected

  async function call(name, args, signal) {
    signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    signal.throwIfAborted()
    if (!client) {
      const {stdout} = await run('/usr/bin/dbus-send', [
        '--session', '--print-reply', '--reply-timeout=3500', '--dest=org.a11y.Bus',
        '/org/a11y/bus', 'org.a11y.Bus.GetAddress',
      ], {env:desktop.env, timeout:4000, signal})
      const address = stdout.match(/string "(unix:[^"]+)"/)?.[1]
      if (!address) throw desktopError(503, 'Linux accessibility bus did not start')
      const env = {
        ...desktop.env, AT_SPI_BUS_ADDRESS:address, TOKIO_WORKER_THREADS:'2', RAYON_NUM_THREADS:'2',
      }
      await run(binary, ['telemetry', 'disable'], {env, cwd:desktop.cwd, timeout:5000, signal})
      const [{Client}, {StdioClientTransport}] = await Promise.all([
        import(pathToFileURL(nativeRequire.resolve('@modelcontextprotocol/client')).href),
        import(pathToFileURL(nativeRequire.resolve('@modelcontextprotocol/client/stdio')).href),
      ])
      signal.throwIfAborted()
      transport = new StdioClientTransport({command:binary, args:['mcp'], cwd:desktop.cwd, env, stderr:'pipe'})
      transport.stderr?.resume()
      client = new Client({name:'flybot-computer', version:'1.0.0'})
      await client.connect(transport, {signal, timeout:8000})
    }
    const result = await client.callTool({name, arguments:args}, {signal, timeout:8000})
    if (result.isError || !result.structuredContent) {
      const detail = result.structuredContent?.detail ?? result.content?.find(item => item.type === 'text')?.text
      throw desktopError(502, short(detail, 450) || 'Cua Driver could not complete the window action')
    }
    return result.structuredContent
  }

  return {
    forgetSnapshot() { inspected = undefined },
    close() {
      lifetime.abort()
      return closing ??= transport?.close() ?? Promise.resolve()
    },
    async act(args, signal) {
      const {action, window_id, element_token, text} = args
      if (action !== 'windows' && (!Number.isSafeInteger(window_id) || window_id <= 0)) {
        throw desktopError(400, 'Use windows to select a window_id')
      }
      if (action === 'click' && (typeof element_token !== 'string' || args.x !== undefined || args.y !== undefined)) {
        throw desktopError(400, 'Use inspect and supply an element_token for a window click')
      }
      if (action === 'type' && (typeof text !== 'string' || text.length === 0 || text.length > 1500)) {
        throw desktopError(400, 'Enter between 1 and 1500 characters')
      }
      const {windows} = await call('list_windows', {on_screen_only:true}, signal)
      const visible = windows.filter(window => window.pid > 0 && !window.title?.startsWith('Cua.AgentCursorOverlay.'))
      if (action === 'windows') return JSON.stringify(visible.slice(0, 40).map(window => ({
        window_id:window.window_id, title:short(window.title), app:short(window.app_name, 80),
      })))
      const window = visible.find(item => item.window_id === window_id)
      if (!window) throw desktopError(404, 'Window is no longer visible in this Bot’s desktop')
      const target = {pid:window.pid, window_id}
      if (action === 'inspect') {
        const state = await call('get_window_state', {
          ...target, tree_format:'elements', include_accessibility_tree:true, include_screenshot:false, max_elements:100,
        }, signal)
        const elements = (state.elements || []).slice(0, 100).map(item => ({
          role:short(item.role, 60), label:short(item.label), value:short(item.value, 400),
          description:short(item.description), actions:item.actions?.slice(0, 8),
          element_token:item.element_token, enabled:item.enabled, frame:item.frame,
        }))
        inspected = {window_id, pid:window.pid, tokens:new Set(elements.map(item => item.element_token).filter(Boolean))}
        return JSON.stringify({window_id, title:short(window.title), elements})
      }
      if (element_token !== undefined && (inspected?.window_id !== window_id || inspected.pid !== window.pid ||
          !inspected.tokens.has(element_token))) {
        throw desktopError(400, 'Use a fresh element_token from inspect on this window')
      }
      inspected = undefined
      const result = await call(action === 'click' ? 'click' : 'type_text', {
        ...target,
        ...(element_token === undefined ? {} : {element_token}),
        ...(action === 'type' ? {text, delivery_mode:'foreground'} : {}),
      }, signal)
      return JSON.stringify({
        effect:short(result.effect, 60), summary:short(result.summary),
        ...(result.effect !== 'confirmed' ? {next:'Inspect the window to verify the action before trying again.'} : {}),
      })
    },
  }
}
