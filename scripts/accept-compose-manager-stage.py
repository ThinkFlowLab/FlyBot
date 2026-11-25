#!/usr/bin/env python3
"""MANUAL opt-in stage on an isolated, already configured Compose fixture.

Not invoked by tests/CI. No pulls/builds/exec/purge. Owner lifecycle intents
must be requested separately; this only drains a job, inspects and reads logs.
"""
import argparse
import contextlib
import io
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from flybot_workspace.manager.__main__ import main

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--config', required=True)
parser.add_argument('--instance-id', required=True)
parser.add_argument('--expected', required=True, choices=('running', 'stopped', 'restart'))
parser.add_argument('--previous-process-ref')
parser.add_argument('--confirm-isolated-fixture', action='store_true')
args = parser.parse_args()
if not args.confirm_isolated_fixture:
    parser.error('Explicit --confirm-isolated-fixture required; never use an existing production instance')
if args.expected == 'restart' and not args.previous_process_ref:
    parser.error('Restart stage requires the previous inspect process_ref')


def command(name):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        code = main(['--config', args.config, '--execute', name, '--instance-id', args.instance_id])
    if code:
        raise SystemExit('Stage failed closed; inspect manager state, never assume the daemon operation stopped')
    return json.loads(output.getvalue())

job, inspection, logs = command('run-once'), command('inspect'), command('logs')
state, snapshot = inspection['engine'], inspection['instance']
expected = 'running' if args.expected == 'restart' else args.expected
if job.get('status') != 'observed' or job.get('revision') != snapshot['revision'] or job.get('observed') != expected:
    raise SystemExit('This stage did not execute and confirm the current fenced job; no acceptance claim')
if args.expected == 'restart' and snapshot['operation']['type'] != 'restart':
    raise SystemExit('Current operation is not restart')
if not snapshot['converged'] or snapshot['observed'] != expected:
    raise SystemExit('Control-plane intent is not converged')
if expected == 'stopped' and not state['stopped']:
    raise SystemExit('Engine is not stopped')
if expected == 'running' and not state['healthy']:
    raise SystemExit('Engine is not healthy')
if args.expected == 'restart' and state['process_ref'] == args.previous_process_ref:
    raise SystemExit('Process identity did not change')
# Do not emit runtime text or credentials as acceptance artifacts by default.
print(json.dumps({'stage': args.expected, 'job': job, 'inspection': inspection,
                  'operator_logs_read': logs['source'] == 'operator-compose-logs',
                  'real_image_application_and_volume_contents_require_separate_manual_evidence': True}))
