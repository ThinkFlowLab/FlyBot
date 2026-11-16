// Shared deterministic effect/timer harness for the two history query hooks.
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
export async function historyHookHarness(entry, exported) {
  const bundled = await build({entryPoints:[fileURLToPath(new URL(entry,import.meta.url))],bundle:true,format:'cjs',platform:'browser',write:false,external:['react']})
  return function mount() {
    const slots=[], effects=[], timers=new Map(); let index=0, sequence=0
    const react={
      useState(initial){const at=index++;if(!(at in slots))slots[at]=initial;return [slots[at],next=>{slots[at]=typeof next==='function'?next(slots[at]):next}]},
      useRef(initial){const at=index++;if(!(at in slots))slots[at]={current:initial};return slots[at]},
      useEffect(run,deps){const at=index++;const old=slots[at];if(!old||deps.some((value,i)=>value!==old.deps[i])){effects.push(()=>{old?.off?.();slots[at]={deps,off:run()}})}},
    }
    const module={exports:{}}
    runInNewContext(bundled.outputFiles[0].text,{module,exports:module.exports,require:()=>react,AbortController,setTimeout:fn=>{const id=++sequence;timers.set(id,fn);return id},clearTimeout:id=>timers.delete(id)})
    return {
      draw(...args){index=0;const result=module.exports[exported](...args);while(effects.length)effects.shift()();return result},
      tick(){for(const [id,run] of timers){timers.delete(id);run()}},
      unmount(){for(const value of slots)value?.off?.()},
    }
  }
}
