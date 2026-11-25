"""Reserve new per-account Compose bridges from an optional operator pool."""
from contextlib import ExitStack
from ipaddress import IPv4Network, ip_network
import re
import time

from .client import check_id
from .safety import ManagerError, instance_lock, json_loads, require

BRIDGE_PREFIX = 28
PRIVATE_POOLS = tuple(IPv4Network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
NETWORK_ID = re.compile(r'[0-9a-f]{64}')


def runtime_pool(value):
    try:
        pool = IPv4Network(value)
    except (TypeError, ValueError):
        raise ManagerError('runtime_network_pool') from None
    require(isinstance(value, str) and str(pool) == value and 16 <= pool.prefixlen <= BRIDGE_PREFIX
            and any(pool.subnet_of(private) for private in PRIVATE_POOLS), 'runtime_network_pool')
    return pool


def _network_ids(runner, heartbeat, name=None):
    args = ['network', 'ls', '--no-trunc', '--quiet']
    if name is not None:
        args.extend(['--filter', 'name=^' + name + '$'])
    raw, _ = runner.run(args, heartbeat=heartbeat)
    ids = raw.split()
    require(len(ids) == len(set(ids)) and all(NETWORK_ID.fullmatch(value) for value in ids), 'runtime_network_list')
    return ids


def _account_network(runner, project, heartbeat):
    name = project + '_default'
    ids = _network_ids(runner, heartbeat, name)
    if not ids:
        return None
    require(len(ids) == 1, 'runtime_network_owner')
    raw, _ = runner.run(['network', 'inspect', ids[0]], heartbeat=heartbeat)
    data = json_loads(raw)
    require(isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict), 'runtime_network_inspect')
    network = data[0]
    labels = network.get('Labels')
    require(network.get('Id') == ids[0] and network.get('Name') == name
            and network.get('Driver') == 'bridge' and network.get('Scope') == 'local'
            and network.get('Internal') is False and isinstance(labels, dict)
            and labels.get('com.docker.compose.project') == project
            and labels.get('com.docker.compose.network') == 'default', 'runtime_network_owner')
    return network


def _subnets(entries):
    require(entries is None or isinstance(entries, list), 'runtime_network_ipam')
    for entry in entries or ():
        value = entry.get('Subnet') if isinstance(entry, dict) else None
        require(isinstance(value, str) and value, 'runtime_network_ipam')
        try:
            yield ip_network(value)
        except ValueError:
            raise ManagerError('runtime_network_ipam') from None


def _next_subnet(runner, pool, heartbeat):
    ids = _network_ids(runner, heartbeat)
    occupied = []
    for offset in range(0, len(ids), 64):
        chunk = ids[offset:offset + 64]
        raw, _ = runner.run(['network', 'inspect', '--format', '{{json .IPAM.Config}}', *chunk],
                            heartbeat=heartbeat)
        rows = raw.splitlines()
        require(len(rows) == len(chunk), 'runtime_network_ipam')
        for row in rows:
            occupied.extend(value for value in _subnets(json_loads(row)) if value.version == 4 and value.overlaps(pool))
    for subnet in pool.subnets(new_prefix=BRIDGE_PREFIX):
        if not any(subnet.overlaps(value) for value in occupied):
            return subnet
    raise ManagerError('runtime_network_capacity')


def reserve_bridge(registry, runner, iid, heartbeat):
    project = 'ot-' + check_id(iid)
    if _account_network(runner, project, heartbeat) is not None:
        return
    # The two workers and separate operator invocations share this registry.
    # Keep renewing the caller's lease while another allocation completes.
    deadline = time.monotonic() + 10
    with ExitStack() as stack:
        while True:
            try:
                stack.enter_context(instance_lock(registry.root, 'runtime-ipv4-pool'))
                break
            except ManagerError as error:
                if error.code != 'instance_busy':
                    raise
                require(time.monotonic() < deadline, 'runtime_network_busy')
                heartbeat()
                time.sleep(0.05)
        if _account_network(runner, project, heartbeat) is not None:
            return
        registry.entry(iid)
        subnet = _next_subnet(runner, registry.runtime_ipv4_pool, heartbeat)
        # Compose uses an existing default bridge with these owner labels and no
        # Compose config-hash. The frozen manifest and service hash stay intact.
        raw, _ = runner.run(['network', 'create', '--driver', 'bridge', '--subnet', str(subnet),
                             '--label', 'com.docker.compose.project=' + project,
                             '--label', 'com.docker.compose.network=default', project + '_default'],
                            heartbeat=heartbeat)
        require(NETWORK_ID.fullmatch(raw.strip()), 'runtime_network_create')
        network = _account_network(runner, project, heartbeat)
        require(network is not None and network['Id'] == raw.strip(), 'runtime_network_owner')
        ipam = network.get('IPAM')
        require(isinstance(ipam, dict) and list(_subnets(ipam.get('Config'))) == [subnet], 'runtime_network_ipam')
