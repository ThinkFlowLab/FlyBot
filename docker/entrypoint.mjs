#!/usr/bin/env node
// Container entry point (#352): link the image's FlyBot packages into the web profile on the
// data volume, then run `dsh web` in the foreground. Keys come from the environment or from
// the credentials file on the volume; nothing secret is baked into the image.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { prepareProfile } from './profile.mjs'

const dshHome = process.env.DSH_HOME || '/data'
const packagesDir = process.env.FLYBOT_PACKAGES || '/opt/flybot/packages'
const profile = prepareProfile(dshHome, packagesDir)
// Links need no download; a plugin you added yourself comes from the pnpm store on the volume.
execFileSync('pnpm', ['install', '--prefer-offline', '--silent'], { cwd: profile, stdio: 'inherit' })
const workspace = join(dshHome, 'workspace')
mkdirSync(workspace, { recursive: true })

// The web server listens on all interfaces of the container only (web.patch.yml); compose
// publishes that port on the host's 127.0.0.1. The sign-in link is DSH's own ?token= link.
const args = ['--profile', 'web', '--patch', join(import.meta.dirname, 'web.patch.yml'), '--no-open', '--port', '3080', ...process.argv.slice(2)]
const child = spawn('dsh', args, { cwd: workspace, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
