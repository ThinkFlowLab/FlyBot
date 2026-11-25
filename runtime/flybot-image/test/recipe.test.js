import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import {withSpeechOverlay} from '../speech-overlay.mjs'
import { applyNativeOverlay, assertNativeConsentOverlay } from '../native-ds-bot-overlay.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(root, '..', '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

test('the web image enables local meeting speech without repeating the optional voice bundle', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ot-speech-profile-'))
  t.after(() => rmSync(home, {recursive:true, force:true}))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, {recursive:true})
  const writeProfile = bundles => writeFileSync(join(profile, 'package.json'), JSON.stringify({dsh:{profile:{bundles}}}))
  const args = ['--profile', 'web', '--no-open']
  writeProfile([])
  const expanded = withSpeechOverlay(args, home)
  assert.deepEqual(expanded, ['--profile', 'web', '--patch', join(root, 'meeting-speech.patch.yml'), '--no-open'])
  assert.match(read('meeting-speech.patch.yml'), /defaultProvider: sensevoice-local/)
  assert.match(read('meeting-speech.patch.yml'), /dshHomePath\('speech-to-text', 'sensevoice'\)/)
  writeProfile(['@deepseek-ai/dsh-experimental-voice-input-bundle'])
  assert.deepEqual(withSpeechOverlay(args, home), args)
})

test('image matches the compose manager contract (UID 1000, port 8080, healthcheck)', () => {
  const docker = read('Dockerfile')
  assert.match(docker, /^\s*USER 1000:1000\s*$/m)
  assert.match(docker, /^\s*EXPOSE 8080\s*$/m)
  assert.match(docker, /^\s*HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --start-interval=500ms --retries=5 /m)
  assert.ok(docker.includes('CMD ["sh", "/opt/flybot-workspace/runtime/flybot-image/healthcheck.sh"]'))
  assert.match(docker, /DSH_LISTEN_PORT=8080/)
  assert.match(docker, /flybot-image\/entrypoint\.sh/)
  const engine = readFileSync(join(repo, 'flybot_workspace', 'manager', 'engine.py'), 'utf8')
  assert.match(engine, /'target': 8080/)
  assert.match(engine, /'user': '1000:1000'/)
  assert.match(engine, /'read_only': True/)
  assert.match(engine, /'target': '\/data'/)
})

test('the shell health probe accepts a ready DSH listener and fails on an unavailable service', async (t) => {
  let status = 401
  const server = createServer((_req, res) => res.writeHead(status).end())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const port = String(server.address().port)
  const hosts = []
  server.on('request', request => hosts.push(request.headers.host))
  const probe = () => new Promise(resolve => execFile('sh', [join(root, 'healthcheck.sh')], {
    env: {...process.env, DSH_LISTEN_PORT:port, http_proxy:'http://127.0.0.1:1'},
  }, error => resolve(error?.code ?? 0)))
  assert.equal(await probe(), 0)
  status = 200
  assert.equal(await probe(), 0)
  status = 503
  assert.equal(await probe(), 1)
  assert.equal(hosts.length, 3)
})

test('entrypoint is non-root and keeps the workspace on /data', () => {
  const entry = read('entrypoint.sh')
  const body = entry.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  assert.doesNotMatch(body, /\b(gosu|groupmod|usermod|chown)\b/)
  assert.match(entry, /DSH_LISTEN_PORT:-8080/)
  assert.match(entry, /mkdir -p \/data\/workspace/)
  assert.match(entry, /TMPDIR=\/data\/tmp/)
  assert.match(entry, /launch\.mjs/)
  assert.match(entry, /cd \/data\/workspace/)
  const patch = read('docker.patch.yml')
  assert.match(patch, /workspace: \/data\/workspace/)
})

test('wrapper plugin boots upstream createRuntime and the social façade once', () => {
  const plugin = read('plugin/index.js')
  assert.match(plugin, /from '\.\.\/\.\.\/ds-bot-upstream\/ds-bot\/index\.js'/)
  assert.match(plugin, /from '\.\.\/\.\.\/flybot-social-host\/index\.js'/)
  assert.match(plugin, /createRuntime\(/)
  assert.match(plugin, /applyOnRuntime\(/)
  assert.match(plugin, /loadBotSocialConfig/)
  assert.doesNotMatch(plugin, /onboard:\s*false/)
  assert.match(plugin, /registerFlybotRoute\(/)
  const prepare = read('prepare-template.mjs')
  assert.match(prepare, /name !== 'ds-bot'/)
  assert.match(prepare, /symlinkSync\(dir, dest\)/)
  assert.match(prepare, /link:\$\{dir\}/)

  assert.match(prepare, /@flybot-workspace\/flybot-runtime/)
  const manifest = JSON.parse(read('plugin/package.json'))
  assert.equal(manifest.name, '@flybot-workspace/flybot-runtime')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.exports['./client'], '../../flybot-web-slots/client.js')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  const cordis = read('plugin/cordis.patch.yml')
  const cordisBody = cordis.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  assert.match(cordisBody, /id: bot/)
  assert.match(cordisBody, /name: '@flybot-workspace\/flybot-runtime'/)
  assert.doesNotMatch(cordisBody, /name: ds-bot/)

})

test('recipe does not edit the vendored upstream tree', () => {
  const docker = read('Dockerfile')
  assert.match(docker, /COPY ds-bot-upstream\/ds-bot /)
  assert.match(docker, /RUN node \/opt\/flybot-workspace\/runtime\/flybot-image\/native-ds-bot-overlay\.mjs \/opt\/flybot-workspace\/runtime\/ds-bot-upstream\/ds-bot/)
  assert.match(docker, /npm ci --omit=dev/)
  assert.match(docker, /COPY ds-bot-upstream\/LICENSE \/opt\/licenses\/ds-bot\/LICENSE/)
  assert.match(docker, /COPY ds-bot-upstream\/NOTICE \/opt\/licenses\/ds-bot\/NOTICE/)
  assert.match(docker, /COPY flybot\/LICENSE \/opt\/licenses\/flybot\/LICENSE/)
  assert.match(docker, /COPY third_party\/libreoffice-kit \/opt\/licenses\/libreoffice-kit/)
  assert.match(docker, /COPY third_party\/font-notices \/opt\/licenses\/font-notices/)
  assert.match(docker, /COPY third_party\/sharp-libvips \/opt\/licenses\/sharp-libvips/)
  assert.match(docker, /COPY third_party\/anthropic-sdk \/opt\/licenses\/anthropic-sdk/)
  assert.match(docker, /install-redistribution-notices\.mjs/)

  assert.doesNotMatch(docker, /soffice\.wasm/)
  assert.match(docker, /warm-native-bindings\.cjs/)
  assert.doesNotMatch(docker, /sk-[A-Za-z0-9]/)
  assert.doesNotMatch(docker, /api_key\s*=/)
})

test('the image overlay checks pinned inputs before adding native group and skill integration', async t => {
  const copy = mkdtempSync(join(tmpdir(), 'ot-native-overlay-'))
  t.after(() => rmSync(copy, {recursive:true, force:true}))
  const upstream = join(repo, 'runtime', 'ds-bot-upstream', 'ds-bot')
  for (const path of ['client.js', 'src/client/at-menu.js', 'src/client/group-settings.js', 'src/client/i18n.js', 'src/client/new-chat.js', 'src/client/team-actions.js', 'src/client/text.js', 'src/host/capabilities.js', 'src/host/channel.js', 'src/host/groups.js', 'src/host/bot-tasks.js', 'src/host/parts.js', 'src/host/store.js', 'src/host/threads.js', 'src/shared/mentions.js']) {
    mkdirSync(dirname(join(copy, path)), {recursive:true})
    copyFileSync(join(upstream, path), join(copy, path))
  }
  cpSync(join(upstream, 'src/client/locales'), join(copy, 'src/client/locales'), {recursive:true})
  writeFileSync(join(copy, 'package.json'), '{"type":"module"}')
  const clientPath = join(copy, 'client.js')
  const channelPath = join(copy, 'src/host/channel.js')
  const originalClient = readFileSync(clientPath)
  const originalChannel = readFileSync(channelPath, 'utf8')
  assert.throws(() => assertNativeConsentOverlay(copy), /native skill consent/)
  writeFileSync(channelPath, originalChannel + '\n')
  assert.throws(() => applyNativeOverlay(copy), /Unexpected pinned DS-Bot source: src\/host\/channel.js/)
  assert.deepEqual(readFileSync(clientPath), originalClient)
  writeFileSync(channelPath, originalChannel)
  applyNativeOverlay(copy)
  assertNativeConsentOverlay(copy)
  assert.match(readFileSync(clientPath, 'utf8'), /Shared human participants/)
  assert.match(readFileSync(clientPath, 'utf8'), /data-ot-shared-reply-save/)
  assert.match(readFileSync(clientPath, 'utf8'), /\["mentions", "Only when mentioned"\]/)
  assert.match(readFileSync(join(copy, 'src/client/group-settings.js'), 'utf8'), /\['mentions', 'Only when mentioned'\]/)
  assert.match(readFileSync(clientPath, 'utf8'), /function sharedMentionRows\(/)
  assert.match(readFileSync(clientPath, 'utf8'), /function SharedGroupForm\(/)
  assert.match(readFileSync(join(copy, 'src/host/groups.js'), 'utf8'), /rt\.beginSharedRoomRound = async/)
  assert.match(readFileSync(channelPath, 'utf8'), /remoteParticipants: Array\.isArray\(body\.remoteParticipants\)/)
  assert.match(readFileSync(channelPath, 'utf8'), /flybotWorkspaceReplyPolicy: body\.flybotWorkspaceReplyPolicy/)
  assert.match(readFileSync(channelPath, 'utf8'), /case 'flybot-workspace-group-workspaces':\s+case 'flybot-workspace-group-create':/)
  assert.match(readFileSync(channelPath, 'utf8'), /case 'flybot-workspace-group-directory':\s+case 'flybot-workspace-group-open':/)
  applyNativeOverlay(copy)
  assert.deepEqual(readFileSync(join(upstream, 'client.js')), originalClient)

  const {atSources} = await import(pathToFileURL(join(copy,'src/client/at-menu.js')))
  const agent = {name:'Release [Review] \\ Tools', owner_id:'owner-a', agent_id:'same-agent-id', owner_name:'Lee', owner_handle:'lee-west'}
  const peerAgent = {...agent, owner_id:'owner-b', owner_handle:'lee-east'}
  const shared = (targets, people = 2) => ({
    members:[], remoteParticipants:Array.from({length:people}, () => ({kind:'human'})),
    flybotWorkspace:{conversation_id:'group-id', reply_policy:{targets}},
  })
  const localBot = {id:'local', name:'Local Bot'}
  const view = {ready:true, roomsById:{both:shared([agent,peerAgent]), one:shared([peerAgent]), human:shared([]),
    empty:shared([],1), local:{members:[localBot.id]}}, byId:{local:localBot}, bots:[localBot]}
  const [picker] = atSources({roster:{getSnapshot:() => view}, iconFor:()=>null})
  const candidates = (sessionId, query = '') => picker.candidates({sessionId}, {query})
  const options = await candidates('both')
  assert.deepEqual(options.map(row => [row.name,row.description]),
    [[agent.name,'Lee · @lee-west'],[agent.name,'Lee · @lee-east'],['Everyone','4 members']])
  const [choice] = await candidates('both','lee-east')
  const picked = picker.onPick({candidate:choice}).insert
  assert.equal(picked.label,'@Release [Review] \\ Tools · Lee · @lee-east')
  assert.equal(picked.ref,'@[Release \\[Review\\] \\\\ Tools](ot-agent:owner-b/same-agent-id)')
  assert.equal(await picker.codec.serialize(picked.ref),picked.ref+' ')
  assert.equal(picker.codec.clipboardText(picked.ref),picked.ref+' ')
  assert.deepEqual((await candidates('one')).map(row => row.name),[agent.name,'Everyone'])
  const [everyone] = await candidates('human','全体')
  assert.deepEqual(picker.onPick({candidate:everyone}),{text:'@Everyone '})
  assert.deepEqual(await candidates('empty'),[])
  const [local] = await candidates('local')
  assert.deepEqual(picker.onPick({candidate:local}),{text:'@Local Bot '})
})

test('image recipe does not bake a model API key', () => {
  const files = ['Dockerfile', 'entrypoint.sh', 'launch.mjs', 'docker.patch.yml', 'plugin/index.js']
  for (const rel of files) {
    const text = read(rel)
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8,}/, rel)
    assert.doesNotMatch(text, /["']api_key["']\s*:\s*["'][^"']+["']/, rel)
  }
})

test('template links the web-slot host and loads the social client without bundling ds-bot', () => {
  const prepare = read('prepare-template.mjs')
  assert.match(prepare, /@flybot-workspace\/flybot-web-slots/)
  assert.match(prepare, /@flybot-workspace\/flybot-social-web/)
  assert.match(prepare, /filtered.push\('@flybot-workspace\/flybot-social-web'\)/)
  assert.match(prepare, /name !== 'ds-bot'/)
  const docker = read('Dockerfile')
  assert.match(docker, /COPY flybot-web-slots /)
  const host = JSON.parse(readFileSync(join(root, '..', 'flybot-web-slots', 'package.json'), 'utf8'))
  assert.equal(host.name, '@flybot-workspace/flybot-web-slots')
  const socialWeb = JSON.parse(readFileSync(join(root, '..', 'flybot-web-slots', 'social-web', 'package.json'), 'utf8'))
  assert.equal(socialWeb.exports['./client'], './client.js')
})

test('template bundles the FlyBot DS-Bot plugin and its pages stage', () => {
  const prepare = read('prepare-template.mjs')
  assert.match(prepare, /'@flybot-workspace\/web': `\$\{ROOT\}\/flybot-workspace-web`/)
  assert.match(prepare, /filtered.push\('@flybot-workspace\/web'\)/)
  const docker = read('Dockerfile')
  assert.match(docker, /FROM scratch AS flybot-workspace-static/)
  assert.match(docker, /COPY flybot-workspace-web \/opt\/flybot-workspace\/runtime\/flybot-workspace-web/)
  assert.match(docker, /COPY --from=flybot-workspace-static \/ \/opt\/flybot-workspace\/runtime\/flybot-workspace-web\/pages\//)
  assert.ok(docker.indexOf('COPY flybot-workspace-web') < docker.indexOf('dsh plugin --profile web'), 'plugin is copied before the profile is prepared and chowned')
  const plugin = JSON.parse(readFileSync(join(root, '..', 'flybot-workspace-web', 'package.json'), 'utf8'))
  assert.equal(plugin.name, '@flybot-workspace/web')
  assert.equal(plugin.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(!JSON.stringify(plugin).includes('@flybot/project'), 'never @flybot/project')
})

test('notice installer runs again after the web profile is installed', () => {
  const docker = read('Dockerfile')
  const profile = docker.indexOf('dsh plugin --profile web')
  const second = docker.lastIndexOf('install-redistribution-notices.mjs')
  assert.ok(profile !== -1 && second !== -1)
  assert.ok(second > profile)
})
