import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdir,writeFile} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
const here=dirname(fileURLToPath(import.meta.url))
const out=resolve(here,'dist')
await mkdir(out,{recursive:true})
const options={entryPoints:[resolve(here,'app.js')],bundle:true,format:'iife',platform:'browser',outfile:resolve(out,'fixture.js'),metafile:true,nodePaths:[resolve(here,'node_modules')],define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'explicit-mock-boundaries',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:resolve(here,'primitives.js')}));b.onResolve({filter:/^\.\/api\.js$/},()=>({path:resolve(here,'host.js')}))}}]}
const result=await build(options)
if (process.argv.includes('--render-check')) await build({...options,format:'esm',platform:'node',outfile:resolve(here,'render-check.mjs'),external:['react','react-dom','react-dom/*']})
await writeFile(resolve(out,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src file:; style-src \'unsafe-inline\'; img-src data: blob:; connect-src \'none\'; form-action \'none\'; base-uri \'none\'"><title>FlyBot real-component offline fixture · MOCK HOST</title><div id="root"></div><script src="fixture.js"></script></html>')
await writeFile(resolve(out,'bundle-inputs.json'),JSON.stringify(result.metafile,null,2))
console.log(out+'/index.html')

const inputs=Object.keys(result.metafile.inputs)
for (const file of ['settings','composer','message-fold','memory-panel','group-settings','sidebar','palette','message-tools','header']) assert.ok(inputs.some(path=>path.endsWith('src/client/'+file+'.js')), 'Missing actual component '+file)
assert.ok(!inputs.some(path=>path.endsWith('src/client/api.js')), 'Real host transport must not be bundled')
for (const output of Object.values(result.metafile.outputs)) assert.equal(output.imports.length,0,'Browser bundle must be self contained')
console.log('PASS actual source manifest and no external browser imports / real host transport')
