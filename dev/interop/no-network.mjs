import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import dgram from 'node:dgram'
import tls from 'node:tls'
import http2 from 'node:http2'
import dns from 'node:dns'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const forbidden = () => { throw new Error('offline harness: unexpected network/process call') }
globalThis.fetch = forbidden
globalThis.WebSocket = forbidden
net.Socket.prototype.connect = forbidden
net.Server.prototype.listen = forbidden
http.request = http.get = https.request = https.get = forbidden
dgram.createSocket = forbidden
tls.connect = http2.connect = dns.lookup = dns.resolve = forbidden
dns.promises.lookup = dns.promises.resolve = forbidden
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = forbidden
syncBuiltinESMExports()
