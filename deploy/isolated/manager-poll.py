"""Discover assigned jobs promptly while keeping the existing failure backoff."""

import json
import subprocess
import sys
import time


def run():
    config = '/var/lib/flybot_workspace/manager/runtime/manager.json'
    command = [sys.executable, '-m', 'flybot_workspace.manager', '--config', config, '--execute', 'poll-once']
    failure_delay = 5
    while True:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True)
        try:
            summary = json.loads(result.stdout)
        except ValueError:
            summary = {}
        rows = summary.get('results') if isinstance(summary, dict) else None
        idle = (isinstance(rows, list) and summary.get('status') == 'polled'
                and all(isinstance(job, dict) and job.get('status') in ('no_claim', 'not_running') for job in rows))
        if result.returncode or not idle:
            print(result.stdout, end='', flush=True)
        if result.returncode:
            failure_delay = min(failure_delay * 2, 60)
            time.sleep(failure_delay)
        else:
            failure_delay = 5
            time.sleep(1)


if __name__ == '__main__':
    run()
