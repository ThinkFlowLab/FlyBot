"""Operator CLI; no real HTTP/Docker unless config AND --execute explicitly enable it."""
import argparse
from collections import deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import json
import signal
from pathlib import Path
from threading import Lock
from urllib.parse import urlsplit

from ..security import digest, opaque
from .client import ManagerClient, check_id
from .engine import Registry, Runner, ComposeEngine, manifest
from .safety import ManagerError, require, trusted_path, write_new, instance_lock, redact
from .worker import ManagerWorker
from . import dsbot_import, dsbot_route


def initialize(args):
    check_id(args.instance_id)
    # Validate before creating anything; no Docker or HTTP in init.
    entry = {'image': args.image, 'healthcheck': json.loads(args.healthcheck_json) if args.healthcheck_json else None, 'publish_port': args.publish_port}
    manifest(args.instance_id, entry)
    token = opaque()
    ManagerClient(args.base_url, args.manager_id, token, host_header=args.server_host)
    state = Path(args.state_dir)
    require(state.is_absolute() and not state.exists() and not state.is_symlink(), 'new_absolute_state_dir_required')
    trusted_path(str(state.parent), directory=True)
    state.mkdir(mode=0o700)
    config = {'version': 1, 'execution_enabled': False, 'base_url': args.base_url, 'server_host': args.server_host or urlsplit(args.base_url).netloc, 'manager_id': args.manager_id,
              'token': token, 'docker': args.docker, 'socket': args.socket, 'instances': {args.instance_id: entry}}
    write_new(state / 'manager.json', config)
    write_new(state / 'grants.json', [{'id': args.manager_id, 'credential_hash': digest(token),
              'instance_ids': [args.instance_id], 'backend_mode': 'compose'}])
    return {'status': 'initialized_disabled', 'config': str(state / 'manager.json'), 'server_grants': str(state / 'grants.json')}


def _poll_with_spare_worker(items, initial_work, read_work, poll_instance):
    queue = deque(initial_work)
    scheduled = {item['id'] for item in initial_work}
    reported = {item['id']: item for item in items}
    results = {}
    active = {}
    with ThreadPoolExecutor(max_workers=2) as workers:
        while queue or active:
            while queue and len(active) < 2:
                item = queue.popleft()
                active[workers.submit(poll_instance, item)] = item['id']
            done, _ = wait(active, timeout=1 if len(active) == 1 else None, return_when=FIRST_COMPLETED)
            for future in done:
                results[active.pop(future)] = future.result()
            if not done:
                # While one owner's startup is blocking, let new assignments
                # use the idle worker at the regular discovery cadence.
                for item in read_work():
                    iid = item['id']
                    if iid in scheduled:
                        continue
                    scheduled.add(iid)
                    reported[iid] = item
                    queue.append(item)
    report = []
    for iid, item in reported.items():
        outcome = results[iid] if iid in results else poll_instance(item)
        report.extend(outcome)
    return report


def poll_once(args):
    """One supervisor pass. New server-assigned instances are found through the
    authenticated listing, so neither the Web nor this manager needs a restart.
    Each instance still goes through the single-claim/lease/observe worker; an
    uncertain job is reported, never replayed."""
    require(bool(args.config), 'config_required')
    registry = Registry(args.config)
    require(args.execute and registry.config['execution_enabled'] is True, 'execution_disabled')
    cfg = registry.config
    client = ManagerClient(cfg['base_url'], cfg['manager_id'], cfg['token'], enabled=True, host_header=cfg['server_host'])
    gateway = cfg.get('dsbot_gateway') is not None
    adoption_lock = Lock()

    def priority(item):
        if item['converged'] or item['blocked']:
            return 3
        if item['desired'] == 'running':
            return 0 if item.get('provisioning') == 'auto' and item['revision'] == 1 else 1
        return 2

    def poll_instance(item):
        iid = item['id']
        results = []
        try:
            if iid not in cfg['instances']:
                if item.get('provisioning') != 'auto' or cfg.get('auto_instances') is None:
                    return [{'status': 'skipped', 'instance_id': iid, 'reason': 'instance_not_registered'}]
                with adoption_lock:
                    registry.adopt(iid, item)
            engine = None
            if item['converged'] or item['blocked']:
                # A newer intent arriving during this pass is picked up on the next listing.
                result = {'status': 'no_claim', 'instance_id': iid}
            else:
                registry.entry(iid, item)
                engine = ComposeEngine(registry, Runner(registry, enabled=True))
                result = ManagerWorker(client, registry, engine).run_once(iid)
            results.append(result)
            if not gateway or result.get('status') not in ('observed', 'no_claim'):
                return results

            # Route the owner's browser to this DS-Bot. A refusal here never changes the job receipt.
            if (result.get('observed', item['observed']) != 'running'
                    or (result['status'] == 'no_claim' and not item['converged'])):
                results.append({'status': 'not_running', 'instance_id': iid})
                return results
            if result['status'] == 'no_claim' and item.get('gateway_route_fresh') is True and not args.import_legacy:
                return results
            if engine is None:
                registry.entry(iid, item)
                engine = ComposeEngine(registry, Runner(registry, enabled=True))
            try:
                results.append(dsbot_route.publish(engine, client, iid))
            except ManagerError as error:
                results.append({'status': 'route_refused', 'instance_id': iid, 'reason': error.code})
            if args.import_legacy:
                try:
                    with instance_lock(registry.root, iid):
                        results.append(dsbot_import.deliver(engine, client, iid))
                except ManagerError as error:
                    results.append({'status': 'import_refused', 'instance_id': iid, 'reason': error.code})
        except ManagerError as error:
            results.append({'status': 'refused', 'instance_id': iid, 'reason': error.code})
        return results

    # Keep signup priority and fenced per-instance jobs. Bound concurrent checks
    # so one slow container does not block another owner's queued start.
    items = sorted(client.assigned(), key=priority)

    def needs_work(item):
        return not item['converged'] and not item['blocked']

    def needs_route_repair(item):
        return (gateway and item['converged'] and not item['blocked']
                and item['observed'] == 'running' and item['health'] == 'healthy'
                and item.get('gateway_route_present') is False)

    pending = [item for item in items if needs_work(item)]
    if pending and not args.import_legacy:
        # Give the second slot to a disconnected running owner where possible.
        repairs = [item for item in items if needs_route_repair(item)]

        def read_work():
            latest = sorted(client.assigned(), key=priority)
            return [item for item in latest if needs_route_repair(item)] + [item for item in latest if needs_work(item)]

        results = _poll_with_spare_worker(items, pending[:1] + repairs + pending[1:], read_work, poll_instance)
    else:
        results = [result for item in items for result in poll_instance(item)]
    uncertain = any(r.get('status') == 'uncertain' for r in results)
    return {'status': 'uncertain' if uncertain else 'polled', 'results': results}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', help='Private operator JSON; never an HTTP field')
    parser.add_argument('--execute', action='store_true', help='Explicit local permission to send manager HTTP and invoke configured Docker')
    sub = parser.add_subparsers(dest='command', required=True)
    init = sub.add_parser('init', help='Create a new disabled configuration and digest-only server grants; no overwrite, network or Docker')
    init.add_argument('--state-dir', required=True)
    init.add_argument('--instance-id', required=True)
    init.add_argument('--image', required=True, help='Operator-provided image@sha256 digest; no pulls')
    init.add_argument('--base-url', default='http://127.0.0.1:8080')
    init.add_argument('--server-host', help='Exact configured management origin netloc, e.g. management.example.org; connection still numeric loopback')
    init.add_argument('--manager-id', default='local-compose')
    init.add_argument('--docker', default='/usr/bin/docker')
    init.add_argument('--socket', default='/run/docker.sock')
    init.add_argument('--healthcheck-json', help='Optional CMD argv JSON; otherwise image MUST provide a Docker HEALTHCHECK')
    init.add_argument('--publish-port', type=int, help='Optional loopback-only host port mapping to container TCP8080')
    for name in ('plan', 'inspect', 'logs', 'run-once', 'recover', 'migrate-manifest'):
        cmd = sub.add_parser(name)
        cmd.add_argument('--instance-id', required=True)
        if name == 'logs':
            cmd.add_argument('--tail', type=int, default=100)
        if name == 'recover':
            cmd.add_argument('--apply', action='store_true')
            cmd.add_argument('--confirm-no-active-executors', action='store_true')
            cmd.add_argument('--expected-revision', type=int)
            cmd.add_argument('--operation-id', help='Fresh 16..64 character operator key; reuse this key on uncertain HTTP retry')
        if name == 'migrate-manifest':
            cmd.add_argument('--apply', action='store_true', help='Rewrite a compatible frozen compose file; never deletes the named volume or secret files')
    poll = sub.add_parser('poll-once', help='Discover every instance the server assigns to this manager and run one fenced job each')
    poll.add_argument('--import-legacy', action='store_true', help='Deliver a retained platform bundle when explicitly migrating accounts')
    args = parser.parse_args(argv)
    try:
        if args.command == 'init':
            result = initialize(args)
        elif args.command == 'poll-once':
            result = poll_once(args)
        else:
            require(bool(args.config), 'config_required')
            iid = check_id(args.instance_id)
            registry = Registry(args.config)
            if args.command == 'migrate-manifest':
                preview = registry.preview_manifest(iid) if not args.apply else registry.apply_manifest_upgrade(iid)
                if args.apply and preview.get('status') in ('upgraded', 'current'):
                    engine = ComposeEngine(registry, Runner(registry, enabled=False))
                    if not engine.secret_path(iid).exists():
                        engine.install_secret(iid, None)
                    if not engine.bot_social_path(iid).exists():
                        engine.install_bot_social(iid, None)
                    if not engine.agent_bootstrap_path(iid).exists():
                        engine.install_agent_bootstrap(iid, None)
                    preview['secret_files'] = 'created_if_missing'
                preview['executed'] = False
                preview['volume_deleted'] = False
                result = preview
            else:
                if iid not in registry.config['instances'] and registry.config.get('auto_instances') is not None:
                    # Auto-provisioned: adopt only from the server's authenticated listing.
                    require(args.execute and registry.config['execution_enabled'] is True, 'execution_disabled')
                    cfg = registry.config
                    registry.adopt(iid, ManagerClient(cfg['base_url'], cfg['manager_id'], cfg['token'], enabled=True,
                                                      host_header=cfg['server_host']).snapshot(iid))
                entry, path = registry.entry(iid)
                if args.command == 'plan':
                    result = {'status': 'plan_only', 'instance_id': iid, 'compose_file': str(path), 'image': entry['image'], 'executed': False, 'volume': 'ot-' + iid}
                else:
                    require(args.execute and registry.config['execution_enabled'] is True, 'execution_disabled')
                    cfg = registry.config
                    client = ManagerClient(cfg['base_url'], cfg['manager_id'], cfg['token'], enabled=True, host_header=cfg['server_host'])
                    snapshot = client.snapshot(iid)  # separate grant authorization even for logs/inspect
                    registry.entry(iid, snapshot)
                    engine = ComposeEngine(registry, Runner(registry, enabled=True))
                    if args.command == 'run-once':
                        result = ManagerWorker(client, registry, engine).run_once(iid)
                    else:
                        with instance_lock(registry.root, iid):
                            state = engine.inspect(iid)
                            if args.command == 'inspect':
                                result = {'instance': snapshot, 'engine': state}
                            elif args.command == 'logs':
                                stdout, stderr = engine.compose(iid, 'logs', tail=args.tail)
                                result = {'source': 'operator-compose-logs', 'instance_id': iid, 'tail': args.tail,
                                          'public_runtime_log_api': False, 'text': redact(stdout + '\n' + stderr, (cfg['token'],))}
                            else:
                                result = {'mode': 'dry-run', 'applied': False, 'instance': snapshot, 'engine': state,
                                          'note': 'Wait for all previous executors/daemon actions to finish; apply queues a fenced STOP, never resumes an interrupted action'}
                                if args.apply:
                                    require(args.confirm_no_active_executors, 'explicit_quiescence_confirmation_required')
                                    recovered = client.recover(iid, args.expected_revision, args.operation_id)
                                    result = {'mode': 'applied', 'applied': True, 'result': recovered,
                                              'note': 'Recovery accepted or replayed; inspect current revision and run-once to confirm its fenced STOP before any new owner start'}
        print(json.dumps(result, sort_keys=True))
        return 1 if result.get('status') == 'uncertain' else 0
    except (ManagerError, OSError, ValueError, TypeError, KeyError) as error:
        # Never print exception repr/traceback, raw config, response or Docker output.
        print(json.dumps({'error': 'manager_operation_refused', 'reason': error.code if isinstance(error, ManagerError) else 'invalid_local_configuration', 'hint': 'Check private config, grants, enabled flags, stopped/quiesced recovery and operator documentation'}))
        return 2


if __name__ == '__main__':
    def interrupted(signum, frame):
        raise ManagerError('operator_interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    raise SystemExit(main())
