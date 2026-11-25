"""Write per-user DS-Bot import bundles and the runtime seal key.

Uses dsbot_bundle.build_with_secrets on the platform (via a loopback manager
call) and copies the resulting files into the instance volume at
/data/flybot-workspace/import/<feature>-<version>.bundle. The same 32-byte key is
bound at /run/secrets/flybot-workspace-seal.key. Secrets stay plugin-encrypted on
the user volume after import; they are never written to DS-Bot secrets.js.
"""
import hashlib
import json
import re
from tempfile import TemporaryFile

from .safety import ManagerError, require

FEATURES = ('settings', 'model-api', 'connectors', 'meetings', 'memory', 'automations',
            'agents', 'artifacts', 'skills', 'skill-secrets', 'message-assists', 'skill-run-history')
BUNDLE_NAME = re.compile(r'^[a-z0-9-]{1,40}-v[0-9]{1,4}\.bundle$')
VERSION = 1
IMPORT_DIR = '/data/flybot-workspace/import'
RECEIVE = '''
set -eu
umask 077
dir=/data/flybot-workspace/import
test ! -L "$dir"
mkdir -p "$dir"
tmp=$(mktemp "$dir/.incoming.XXXXXXXX")
trap 'rm -f -- "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$tmp"
actual=$(sha256sum "$tmp")
test "${actual%% *}" = "$2"
dest="$dir/$1"
test ! -L "$dest"
test ! -e "$dest" || test -f "$dest"
test ! -L "$dir/$3"
if test -r "$dest"; then
    existing=$(sha256sum "$dest")
    test "${existing%% *}" = "$2"
else
    mv -fT -- "$tmp" "$dest"
fi
touch -- "$dir/$3"
'''


def _container(engine, iid):
    name = f'ot-{iid}-flybot-1'
    return name


def deliver(engine, client, iid, heartbeat=lambda: None):
    """Install the seal key, fetch sealed bundles, copy them into the volume."""
    require(re.fullmatch(r'[0-9a-f]{32}', iid or ''), 'instance_id')
    _, key = engine.install_seal_key(iid)
    # Additive compose bind; a later no-delete recreate attaches it. The job still
    # writes bundles even if the current container was created before the bind.
    try:
        engine.registry.entry(iid)
    except ManagerError:
        pass
    container = _container(engine, iid)
    inspect, _ = engine.runner.run(['inspect', '-f', '{{.State.Running}}', container], heartbeat=heartbeat, timeout=10)
    require(inspect.strip() == 'true', 'instance_not_running')
    def delivered(name):
        bundle = f'{IMPORT_DIR}/{name}-v{VERSION}.bundle'
        marker = f'{IMPORT_DIR}/.delivered-{name}-v{VERSION}'
        try:
            # Older managers could mark a root-owned bundle as delivered.
            # An absent bundle was already consumed, but an unreadable one must be recopied.
            engine.runner.run(
                ['exec', '-u', '1000:1000', container, 'sh', '-c',
                 'test -f "$1" && { test ! -e "$2" || test -r "$2"; }',
                 'check-delivery', marker, bundle],
                heartbeat=heartbeat, timeout=10)
            return True
        except ManagerError:
            return False

    if all(delivered(name) for name in FEATURES):
        return {'status': 'already-imported', 'instance_id': iid, 'version': VERSION, 'features': list(FEATURES)}
    try:
        data = client.dsbot_import(iid, key.hex())
    except ManagerError as error:
        if error.code == 'import_destination':
            return {'status': 'import_skipped', 'instance_id': iid, 'reason': error.code}
        raise
    require(isinstance(data, dict) and data.get('owner_imported') is True, 'import_shape')
    features = data.get('features')
    require(isinstance(features, list) and len(features) <= 16, 'import_shape')
    written = []
    for item in features:
        require(isinstance(item, dict) and set(item) >= {'name', 'bundle'}, 'import_shape')
        name = item['name']
        require(isinstance(name, str) and (name in FEATURES or re.fullmatch(r'[a-z][a-z0-9-]{0,39}', name)), 'import_feature')
        if delivered(name):
            continue
        filename = f'{name}-v{VERSION}.bundle'
        require(BUNDLE_NAME.fullmatch(filename), 'import_feature')
        raw = (json.dumps(item['bundle'], ensure_ascii=False, separators=(',', ':')) + '\n').encode()
        checksum = hashlib.sha256(raw).hexdigest()
        marker = f'.delivered-{name}-v{VERSION}'
        # Receive as the runtime UID so the bundle is private and readable in a
        # managed read-only container. A truncated stream never reaches its final name.
        with TemporaryFile() as source:
            source.write(raw)
            source.seek(0)
            engine.runner.run(
                ['exec', '-i', '-u', '1000:1000', container, 'sh', '-c', RECEIVE,
                 'receive-bundle', filename, checksum, marker],
                heartbeat=heartbeat, timeout=60, stdin=source)
        written.append(filename)
    return {'status': 'imported', 'instance_id': iid, 'features': written, 'seal_key': 'installed'}
