import { execFile, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join, posix } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { createCuaDriver, cuaAvailable } from './cua-driver.js'

export const COMPUTER_PATH = '/api/flybot-workspace/computer'
const run = promisify(execFile)
const ID = /^[a-f0-9]{32}$/
const LEASE = /^[a-f0-9-]{36}$/
const CAPACITY = 8
const IDLE = 30 * 60_000
const CONTROL_IDLE = 25_000
const CHUNK = 64 * 1024

function fault(status, message) {
  return Object.assign(new Error(message), {status})
}

function reply(body, status = 200, type = 'application/json') {
  return new Response(type === 'application/json' ? JSON.stringify(body) : body, {
    status, headers: {'Content-Type':type, 'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff'},
  })
}

export function computerAvailable() {
  if (process.platform !== 'linux' || process.env.FLYBOT_COMPUTER === '0') return false
  try {
    for (const file of ['/usr/bin/Xtigervnc','/usr/bin/import','/usr/bin/xfdesktop','/usr/share/novnc/core/rfb.js']) {
      accessSync(file, constants.R_OK)
    }
    return true
  } catch { return false }
}

function startProcess(file, args, options) {
  const child = spawn(file, args, {...options, detached:true, stdio:['ignore','ignore','pipe']})
  child.stderr.resume()
  child.once('error', () => {})
  return child
}

function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  // Descendants started by Xfce belong to the same process group.
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
}

function release(desktop, lease = desktop.lease) {
  if (!lease || desktop.lease !== lease) return false
  desktop.lease = null
  clearTimeout(lease.expiry)
  lease.socket.destroy()
  lease.wake?.()
  return true
}

function touch(desktop, lease) {
  clearTimeout(lease.expiry)
  lease.expiry = setTimeout(() => release(desktop, lease), CONTROL_IDLE)
  lease.expiry.unref()
}

export function createComputers(dataDir, {available = computerAvailable} = {}) {
  const sessions = new Map()
  let nextDisplay = 80

  function stop(desktop) {
    if (sessions.get(desktop.id) !== desktop) return
    sessions.delete(desktop.id)
    release(desktop)
    void desktop.driver?.close().catch(() => {})
    for (const child of desktop.apps || []) stopProcess(child)
    for (const child of desktop.shell || []) stopProcess(child)
    stopProcess(desktop.bus)
    stopProcess(desktop.x)
    if (desktop.socketDir) void rm(desktop.socketDir, {recursive:true, force:true}).catch(() => {})
  }

  async function start(desktop, target) {
    const profile = join(dataDir, 'computers', desktop.id)
    const home = join(profile, 'home')
    desktop.socketDir = await mkdtemp('/tmp/fb-x-')
    try {
      if (sessions.get(desktop.id) !== desktop) {
        await rm(desktop.socketDir, {recursive:true, force:true})
        throw fault(503,'Desktop service stopped')
      }
      const caches = join(home, '.cache')
      await mkdir(caches, {recursive:true, mode:0o700})
      await chmod(profile, 0o700)
      const cwd = target.cwd || join(dataDir, 'workspace')
      const socket = join(desktop.socketDir, 'vnc')
      const auth = join(desktop.socketDir, 'auth')
      const display = ':' + nextDisplay++
      const bus = 'unix:path=' + join(desktop.socketDir, 'bus')
      const env = {
        PATH:'/usr/local/bin:/usr/bin:/bin', LANG:'C.UTF-8', HOME:home,
        DISPLAY:display, XAUTHORITY:auth, XDG_RUNTIME_DIR:desktop.socketDir, MOZ_ENABLE_WAYLAND:'0',
        XDG_SESSION_TYPE:'x11', XDG_CURRENT_DESKTOP:'XFCE', SHELL:'/bin/bash',
        DBUS_SESSION_BUS_ADDRESS:bus,
      }
      await run('/usr/bin/xauth', ['-f',auth,'add',display,'MIT-MAGIC-COOKIE-1',randomBytes(16).toString('hex')], {timeout:4000})
      desktop.x = startProcess('/usr/bin/Xtigervnc', [
        display,'-geometry','1280x800','-depth','24','-nolisten','tcp','-auth',auth,
        '-rfbport','-1','-rfbunixpath',socket,'-SecurityTypes','None','-AcceptCutText=0','-SendCutText=0',
        '-AcceptSetDesktopSize=0','-desktop',target.name,
      ], {cwd,env})
      desktop.x.once('exit', () => stop(desktop))
      await waitForDisplay(desktop, async () => {
        await run('/usr/bin/xdpyinfo', [], {env,timeout:650})
        return true
      }, 'Linux display did not start')

      // Xfce's saved session can stall after opening the window manager.
      // Launch the desktop and panel independently in this display and bus.
      desktop.bus = startProcess('/usr/bin/dbus-daemon', ['--session','--nofork','--address=' + bus], {cwd,env})
      desktop.bus.once('exit', () => stop(desktop))
      await waitForDisplay(desktop, async () => {
        await run('/usr/bin/dbus-send', [
          '--session','--print-reply','--dest=org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus.ListNames',
        ], {env,timeout:650})
        return true
      }, 'Linux desktop session bus did not start')

      await run('/usr/bin/xsetroot', ['-solid','#27374b'], {env,timeout:2000})
      desktop.shell = [
        ['/usr/bin/xfwm4',['--compositor=off']],
        ['/usr/bin/xfsettingsd',['--disable-wm-check']],
        ['/usr/bin/xfdesktop',[]],
        ['/usr/bin/xfce4-panel',[]],
      ].map(([file,args]) => startProcess(file,args,{cwd,env}))
      await waitForDisplay(desktop, async () => {
        const {stdout} = await run('/usr/bin/xwininfo',['-root','-tree'],{env,timeout:650})
        const desktopWindow = /"Desktop": \("xfdesktop"/.test(stdout)
        const taskbar = /"xfce4-panel":[^\n]*? [1-9]\d{2,}x[1-9]\d*\+/.test(stdout)
        if (!desktopWindow || !taskbar) return false
        // A mapped X11 window can still be blank while GTK paints the shell.
        const {stdout:colors} = await run('/usr/bin/import', [
          '-window','root','-resize','64x40','-format','%k','info:',
        ], {env,timeout:700})
        return Number(colors.trim()) > 16
      }, 'Linux desktop and taskbar did not start')

      Object.assign(desktop,{env,cwd,socket})
      return desktop
    } catch (error) {
      stop(desktop)
      throw error
    }
  }

  async function waitForDisplay(desktop, check, message) {
    const deadline = Date.now() + 8000
    while (sessions.get(desktop.id) === desktop && Date.now() < deadline) {
      if (await check().catch(() => false)) return
      await delay(120)
    }
    throw fault(503,message)
  }

  function get(target) {
    const existing = sessions.get(target.id)
    if (existing) {
      existing.last = Date.now()
      return existing.ready
    }
    if (sessions.size >= CAPACITY) {
      const idle = [...sessions.values()].filter(item => item.env && !item.lease && !item.bot && Date.now() - item.last > 60_000)
      idle.sort((a,b) => a.last - b.last)
      if (!idle[0]) throw fault(429,'Too many desktops are active. Try again shortly.')
      stop(idle[0])
    }
    const desktop = {id:target.id,last:Date.now(),lease:null,bot:null,apps:new Set()}
    sessions.set(target.id, desktop)
    desktop.ready = start(desktop,target)
    return desktop.ready
  }

  async function screenshot(desktop, small = false) {
    if (desktop.lease && !small) throw fault(409,'The owner is controlling the desktop')
    const args = ['-window','root']
    if (small) args.push('-resize','800x')
    args.push('png:-')
    const {stdout} = await run('/usr/bin/import', args, {
      env:desktop.env, encoding:'buffer', timeout:7000, maxBuffer:8 * 1024 * 1024,
    })
    return stdout
  }

  async function take(desktop) {
    if (desktop.lease || desktop.bot) throw fault(409,desktop.lease ? 'Another tab is controlling this desktop' : 'The Bot is finishing a desktop action. Try again.')
    desktop.driver?.forgetSnapshot()
    const socket = createConnection(desktop.socket)
    const lease = {id:randomUUID(),socket,chunks:[],size:0,wake:null,reading:false,writing:false}
    desktop.lease = lease
    socket.on('error', () => release(desktop, lease))
    socket.on('close', () => release(desktop, lease))
    socket.on('data', chunk => {
      lease.chunks.push(chunk)
      lease.size += chunk.length
      if (lease.size >= 8 * CHUNK) socket.pause()
      lease.wake?.()
    })
    touch(desktop,lease)
    return lease.id
  }

  async function read(desktop, lease, signal) {
    if (lease.reading) throw fault(409,'A screen update is already pending')
    lease.reading = true
    try {
      if (lease.size === 0) {
        await new Promise(resolve => {
          const done = () => {
            clearTimeout(timeout)
            signal.removeEventListener('abort',done)
            resolve()
          }
          const timeout = setTimeout(done,3500)
          lease.wake = done
          if (signal.aborted) done()
          else signal.addEventListener('abort',done,{once:true})
        })
      }
      if (desktop.lease !== lease) throw fault(410,'Desktop control has ended')
      let bytes = 0
      const batch = []
      while (lease.chunks.length && bytes < CHUNK) {
        const chunk = lease.chunks.shift()
        bytes += chunk.length
        batch.push(chunk)
      }
      lease.size -= bytes
      if (lease.size < 4 * CHUNK) lease.socket.resume()
      return reply(Buffer.concat(batch,bytes),200,'application/octet-stream')
    } finally {
      lease.wake = null
      lease.reading = false
    }
  }

  const timer = setInterval(() => {
    const now = Date.now()
    for (const desktop of sessions.values()) {
      if (desktop.env && !desktop.lease && !desktop.bot && now - desktop.last > IDLE) stop(desktop)
    }
  },60_000)
  timer.unref()

  return {
    available,
    close() {
      clearInterval(timer)
      for (const desktop of sessions.values()) stop(desktop)
    },
    async botAction(target, args, signal) {
      signal?.throwIfAborted()
      const desktop = await get(target)
      signal?.throwIfAborted()
      if (desktop.lease || desktop.bot) throw fault(409,'The desktop is busy or the owner is controlling it')
      desktop.bot = true
      try {
        if (args.action === 'screenshot') return await screenshot(desktop)
        if (args.action === 'open') {
          const apps = {
            browser:['/usr/bin/firefox-esr',['--new-window']],
            files:['/usr/bin/thunar',[desktop.cwd]],
            terminal:['/usr/bin/xfce4-terminal',['--disable-server']],
            editor:['/usr/bin/mousepad',[]],
          }
          if (!Object.hasOwn(apps,args.app)) throw fault(400,'Choose browser, files, terminal or editor')
          const [file,argv] = apps[args.app]
          if (args.app === 'browser' && args.url) {
            const url = new URL(args.url)
            if (!['https:','http:'].includes(url.protocol)) throw fault(400,'Only HTTP(S) pages can be opened')
            argv.push(url.href)
          }
          desktop.driver?.forgetSnapshot()
          const child = startProcess(file,argv,{cwd:desktop.cwd,env:desktop.env})
          desktop.apps.add(child)
          child.once('close', () => desktop.apps.delete(child))
          return 'Opened ' + args.app
        }
        if (args.action === 'key' && args.window_id !== undefined) {
          throw fault(400,'Key actions use the focused desktop window without window_id')
        }
        if (['windows','inspect'].includes(args.action) ||
            (['click','type'].includes(args.action) && (args.window_id !== undefined || args.element_token !== undefined))) {
          if (!cuaAvailable()) throw fault(503,'Window inspection is unavailable on this runtime')
          const driver = desktop.driver ??= createCuaDriver(desktop)
          try {
            return await driver.act(args, signal)
          } catch (error) {
            if (!error.status || error.status >= 500) {
              await driver.close().catch(() => {})
              desktop.driver = null
            }
            throw error
          }
        }
        desktop.driver?.forgetSnapshot()
        let argv
        if (args.action === 'click' && Number.isInteger(args.x) && Number.isInteger(args.y) &&
            args.x >= 0 && args.x < 1280 && args.y >= 0 && args.y < 800) {
          argv = ['mousemove',String(args.x),String(args.y),'click','1']
        }
        if (args.action === 'key' && /^[A-Za-z0-9_+]{1,45}$/.test(args.key || '')) argv = ['key','--',args.key]
        if (args.action === 'type' && typeof args.text === 'string' && args.text.length > 0 && args.text.length <= 1500) {
          argv = ['type','--clearmodifiers','--',args.text]
        }
        if (!argv) throw fault(400,'Invalid desktop action')
        await run('/usr/bin/xdotool',argv,{env:desktop.env,timeout:6000,signal})
        return 'Done'
      } finally {
        desktop.bot = false
      }
    },
    handler(resolve) {
      return async request => {
        if (!available()) return reply({error:'Desktop unavailable'},404)
        try {
          const query = new URL(request.url).searchParams
          const op = query.get('op')
          const method = request.method
          if (method === 'GET' && op === 'asset') {
            const asset = query.get('name') || ''
            if (!/^(?:core|vendor)\/[a-zA-Z0-9_/-]+\.js$/.test(asset) || posix.normalize(asset) !== asset) {
              throw fault(404,'Asset not found')
            }
            const source = await readFile(join('/usr/share/novnc',asset),'utf8').catch(() => { throw fault(404,'Asset not found') })
            // The Debian noVNC build uses relative module imports. Rebase them on
            // the authenticated Fetch route, whose path is exact rather than a prefix.
            const js = source.replace(/(['"])(\.\.?\/[a-zA-Z0-9_.\/-]+\.js)\1/g, (_match, quote, path) => {
              const name = posix.normalize(posix.join(posix.dirname(asset),path))
              return quote + '/b' + COMPUTER_PATH + '?op=asset&name=' + encodeURIComponent(name) + quote
            })
            return reply(js,200,'text/javascript; charset=utf-8')
          }
          const workspace = query.get('workspace')
          const id = query.get('agent')
          if (!ID.test(workspace || '') || !ID.test(id || '')) throw fault(404,'Unknown Bot')
          const target = await resolve(workspace,id)
          if (!target || !/^[a-zA-Z0-9_-]{1,80}$/.test(target.id)) throw fault(404,'Unknown Bot')
          if (method === 'GET' && op === 'status') return reply({available:true})
          if (method === 'POST' && op === 'start') {
            await get(target)
            return reply({started:true})
          }
          const desktop = await sessions.get(target.id)?.ready
          if (!desktop) throw fault(410,'Desktop session has ended')
          desktop.last = Date.now()
          if (method === 'GET' && op === 'preview') {
            desktop.preview ??= screenshot(desktop,true).finally(() => { desktop.preview = null })
            return reply(await desktop.preview,200,'image/png')
          }
          if (method === 'POST' && op === 'take') return reply({lease:await take(desktop)})
          const token = query.get('lease') || ''
          const lease = desktop.lease
          if (!lease || !LEASE.test(token) || lease.id !== token) throw fault(410,'Desktop control has ended')
          if (method === 'DELETE' && op === 'control') {
            release(desktop,lease)
            return reply({released:true})
          }
          touch(desktop,lease)
          if (method === 'GET' && op === 'control') return await read(desktop,lease,request.signal)
          if (method === 'POST' && op === 'control') {
            if (lease.writing) throw fault(409,'An input update is already pending')
            lease.writing = true
            try {
              if (Number(request.headers.get('content-length')) > CHUNK) throw fault(413,'Input is too large')
              const bytes = Buffer.from(await request.arrayBuffer())
              if (bytes.length > CHUNK) throw fault(413,'Input is too large')
              await new Promise((resolve,reject) => lease.socket.write(bytes,error => error ? reject(error) : resolve()))
              return reply({accepted:true})
            } finally { lease.writing = false }
          }
          throw fault(405,'Unsupported desktop operation')
        } catch (error) {
          return reply({error:error.status ? error.message : 'Desktop request failed'},error.status || 503)
        }
      }
    },
  }
}
