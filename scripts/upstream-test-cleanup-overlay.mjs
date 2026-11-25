// Owned test-only lifecycle overlay, never imported by the production image.
// Node after hooks run in registration order. These pinned fixtures register
// removal before their runtime disposer, so pending saves can race rmSync.
// Await the existing disposer before removal and keep every assertion and
// cleanup option.
import {createHash} from 'node:crypto';
export const target=new URL('../runtime/ds-bot-upstream/ds-bot/test/rounds.test.js',import.meta.url).href;
export const marker="test('a group whose state was not saved after its last line goes on numbering after the book', async (t) => {";
const expected='dbf624f0f5659b6ff8d8233db7a07e85b8e581609d9e9cd15aa6428a600e2d5b';
export const replacements=[
 ["  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))",
  "  let stopRestarted\n  t.after(async () => {\n    if (stopRestarted) await stopRestarted()\n    rmSync(home, { recursive: true, force: true, maxRetries: 5 })\n  })"],
 ["  t.after(() => again.stop({ keep: true }))","  stopRestarted = () => again.stop({ keep: true })"],
];
export const deliveryTarget=new URL('../runtime/ds-bot-upstream/ds-bot/test/delivery-dedup.test.js',import.meta.url).href;
export const deliveryMarker="test('a concurrent duplicate waits for the delivery already going and shares its failure', async (t) => {";
const deliveryHash='ea6da10af31c5b6bc582a89fbabf2a0ebb6d2a06538418d4d5e072c1cb7da244';
export const deliveryReplacements=[
 ["  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))",
  "  let host\n  t.after(async () => {\n    await host?.stop()\n    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })\n  })"],
 ["  const host = await createRestartHost(t, home, new Map())\n  t.after(() => host.stop())",
  "  host = await createRestartHost(t, home, new Map())"],
];

function transformFixture(source,name,hash,marker,replacements){
 if(createHash('sha256').update(source).digest('hex')!==hash)throw Error('Upstream '+name+' fixture changed: independently review cleanup ordering');
 const begin=source.indexOf(marker),end=source.indexOf('\n})',begin);
 if(begin<0||end<0)throw Error('Missing exact '+name+' fixture');
 let block=source.slice(begin,end);
 for(const [before,after]of replacements){
  if(block.split(before).length!==2)throw Error('Unexpected '+name+' cleanup wiring');
  block=block.replace(before,after);
 }
 return source.slice(0,begin)+block+source.slice(end);
}

export function transformRestartFixture(source){
 return transformFixture(source,'rounds',expected,marker,replacements);
}

export function transformDeliveryFixture(source){
 return transformFixture(source,'delivery dedup',deliveryHash,deliveryMarker,deliveryReplacements);
}
