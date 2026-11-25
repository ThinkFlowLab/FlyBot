// Manager-side JSON bridge only: never imports child_process or executes a plan.
import { planComposeCommand } from './compose-command-planner.js';
let input = '';
try {
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    if (Buffer.byteLength(input) > 131072) throw new Error('bounded');
  }
  const envelope = JSON.parse(input);
  const result = planComposeCommand(envelope.registry, envelope.request);
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'invalid_request', message: 'Invalid bounded planner input' } }));
  process.exitCode = 1;
}
