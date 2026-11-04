// Resource-local credential FIFO; tokens stay in memory and credential-helper pipes.
import { serveRoleCredentials } from './project-role-github-channel.mjs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
export async function roleGithubRuntime({ metadata, scratchDirectory, env, credential }) {
  const directory = await mkdtemp(join(tmpdir(), 'flybot-gh-')), bin = join(scratchDirectory, 'github-bin'), file = join(directory, 'scope.json'), secrets = new Set()
  let closed = false
  const channel = serveRoleCredentials(directory, async () => {
    if (closed) throw Error('Closed role credential channel')
    const value = await credential()
    if (closed || value.metadata.sha256 !== metadata.sha256) throw Error('Role scope changed')
    if (secrets.size >= 256) secrets.delete(secrets.values().next().value)
    secrets.add(value.token)
    return value
  })
  try {
    await mkdir(bin, { mode: 0o700 }); await writeFile(file, JSON.stringify({ ...metadata, authDirectory: directory }), { mode: 0o600 })
    for (const tool of ['git', 'gh']) await writeFile(join(bin, tool), `#!${process.execPath}\nimport { main } from ${JSON.stringify(new URL('./project-role-github-cli.mjs', import.meta.url).href)}; await main(${JSON.stringify(file)},${JSON.stringify(tool)},process.argv.slice(2));\n`, { mode: 0o700 })
    const author = metadata.author
    return { authDirectory: directory, env: { ...env, GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '', PATH: bin + ':' + env.PATH, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GH_CONFIG_DIR: join(directory, 'gh') },
      redact(value) { if (value === undefined) return value; let text = JSON.stringify(value); for (const token of secrets) text = text.split(token).join('[REDACTED]'); return JSON.parse(text) },
      async close() { closed = true; channel.close(); await rm(directory, { recursive: true, force: true }); await rm(bin, { recursive: true, force: true }) } }
  } catch (error) { closed = true; channel.close(); await rm(directory, { recursive: true, force: true }); await rm(bin, { recursive: true, force: true }); throw error }
}
