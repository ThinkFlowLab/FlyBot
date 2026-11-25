#!/usr/bin/env python3
"""TEMPORARY TEST STUB, NOT DOCKER. Only filesystem state; no images or containers."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

args = sys.argv[5:]  # --host VALUE --config VALUE
root = Path(sys.argv[4]).parent
statefile, controlsfile = root / 'stub-engine.json', root / 'stub-controls.json'
state = json.loads(statefile.read_text()) if statefile.exists() else {}
ctrl = json.loads(controlsfile.read_text()) if controlsfile.exists() else {}

def save():
    statefile.write_text(json.dumps(state))

def emit(value):
    print(json.dumps(value))

if args[:2] == ['volume', 'ls']:
    # Literal-substring fixture model exposes callers relying on regex anchors.
    # This model is not evidence of any particular real daemon's semantics.
    fragment = args[args.index('--filter') + 1].removeprefix('name=') if '--filter' in args else ''
    if state.get('volume') and fragment in state['project']:
        print(state['project'])
elif args[:2] == ['volume', 'inspect']:
    error = ctrl.get('volume_inspect_error')
    if error or not state.get('volume') or args[2] != state.get('project'):
        print(ctrl.get('volume_error_stdout', '[]'))
        print(error or ('Error response from daemon: get ' + args[2] + ': no such volume'), file=sys.stderr)
        raise SystemExit(ctrl.get('volume_error_code', 1))
    if ctrl.get('volume_inspect_raw') is not None:
        print(ctrl['volume_inspect_raw']); raise SystemExit(0)
    if ctrl.get('volume_inspect_warning'):
        print('unexpected warning', file=sys.stderr)
    emit([{'Name': args[2], 'Driver': ctrl.get('volume_driver', 'local'), 'Scope': ctrl.get('volume_scope', 'local'), 'Options': {'device': '/untrusted'} if ctrl.get('volume_driver_options') else None, 'Labels': {'com.docker.compose.project': 'wrong' if ctrl.get('wrong_volume') else args[2], 'com.docker.compose.volume': 'data'}}])
elif args[:4] == ['ps', '--all', '--quiet', '--no-trunc']:
    filters = args[4:]
    assert len(filters) == 6 and filters[::2] == ['--filter'] * 3
    project, service, config_hash = filters[1::2]
    assert project.startswith('label=com.docker.compose.project=ot-')
    assert service == 'label=com.docker.compose.service=flybot'
    assert config_hash == 'label=com.docker.compose.config-hash'
    if 'container_list_raw' in ctrl:
        print(ctrl['container_list_raw'])
    elif state.get('id') and project == 'label=com.docker.compose.project=' + state['project']:
        print(state['id'])
elif args[0] == 'inspect':
    iid = state['project'][3:]
    manifest = json.loads((root / ('compose-' + iid + '.json')).read_text())
    running = state['running']
    mounts = [{'Type': 'volume', 'Name': state['project'], 'Destination': '/data', 'RW': True}]
    binds = []
    if state.get('binds'):
        for item in state['binds']:
            mounts.append({k: item[k] for k in ('Type', 'Source', 'Destination', 'RW')})
            binds.append(item['bind'])
    else:
        for volume in manifest['services']['flybot'].get('volumes', []):
            if isinstance(volume, dict) and volume.get('type') == 'bind':
                source = str((root / volume['source']).resolve()) if not Path(volume['source']).is_absolute() else volume['source']
                mounts.append({'Type': 'bind', 'Source': source, 'Destination': volume['target'], 'RW': not volume.get('read_only', False)})
                binds.append(source + ':' + volume['target'] + (':ro' if volume.get('read_only') else ''))
    volume_name = 'other-volume' if ctrl.get('substitute_volume_bind') else state['project']
    volume_bind = volume_name + ':/data:rw'
    if volume_bind not in binds:
        binds.insert(0, volume_bind)
    if ctrl.get('extra_bind'):
        mounts.append({'Type': 'bind', 'Source': '/etc/passwd', 'Destination': '/evil', 'RW': False})
        binds.append('/etc/passwd:/evil:ro')
    emit([{'Id': args[-1], 'Config': {'Image': manifest['services']['flybot']['image'], 'User': '1000:1000',
           'Labels': {'com.docker.compose.project': 'wrong' if ctrl.get('wrong_project') else state['project'],
                      'com.docker.compose.service': 'flybot', 'com.docker.compose.config-hash': 'test-compose-config'}},
           'HostConfig': {'Privileged': bool(ctrl.get('privileged')), 'ReadonlyRootfs': True, 'CapDrop': ['ALL'],
                          'SecurityOpt': ['no-new-privileges:true'], 'IpcMode': 'private', 'NetworkMode': state['project'] + '_default', 'PortBindings': {},
                          'Binds': binds, 'Memory': state.get('memory_bytes', 0)},
           'State': {'Status': 'running' if running else 'exited', 'Running': running, 'Paused': False, 'Restarting': False,
                     'StartedAt': '2026-11-16T00:00:00.' + str(state.get('generation', 0)).zfill(9) + 'Z',
                     'Health': {'Status': 'starting' if ctrl.get('not_ready') else 'healthy'}},
           'Mounts': mounts}])
elif args[0] == 'compose':
    project = args[args.index('-p') + 1]
    verb = args[args.index('-p') + 2]
    if verb in ('create', 'up', 'stop', 'restart'):
        if verb == 'up':
            time.sleep(ctrl.get('start_delay', 0))
        state.setdefault('id', hashlib.sha256(project.encode()).hexdigest())
        state.update(project=project, volume=True, env_keys=sorted(os.environ), last_argv=args)
        state.setdefault('sentinel', 'persistent-test-content')
        force = '--force-recreate' in args
        if '-v' in args or '--volumes' in args:
            raise SystemExit(63)  # tests must never request volume deletion
        if verb in ('create', 'up') and (force or 'binds' not in state):
            iid = project[3:]
            manifest = json.loads((root / ('compose-' + iid + '.json')).read_text())
            memory = manifest['services']['flybot']['mem_limit']
            state['memory_bytes'] = int(memory[:-1]) * {'g': 1024 ** 3, 'm': 1024 ** 2}[memory[-1]]
            snap = []
            for volume in manifest['services']['flybot'].get('volumes', []):
                if isinstance(volume, dict) and volume.get('type') == 'bind':
                    source = str((root / volume['source']).resolve()) if not Path(volume['source']).is_absolute() else volume['source']
                    snap.append({'Type': 'bind', 'Source': source, 'Destination': volume['target'], 'RW': not volume.get('read_only', False),
                                 'bind': source + ':' + volume['target'] + (':ro' if volume.get('read_only') else '')})
            state['binds'] = snap
        if verb in ('up', 'restart'):
            if not ctrl.get('unchanged_identity') or not state.get('generation'):
                state['generation'] = state.get('generation', 0) + 1
            state['running'] = True
        else:
            state['running'] = False
        save()
    elif verb == 'logs':
        time.sleep(ctrl.get('log_delay', 0))
        if ctrl.get('log_bytes'):
            print('x' * ctrl['log_bytes'])
        else:
            print('stub only {"password":"synthetic-password","token":"synthetic-token"} Bearer manager.synthetic-bearer')
    else:
        raise SystemExit(61)
else:
    raise SystemExit(62)
