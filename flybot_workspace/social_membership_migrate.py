"""Trusted, idempotent platform → Bot Social membership migration.

Ownership comes only from a manager-attested tuple:

  platform account UUID → that account's isolated runtime instance → the
  Social owner/home already provisioned on that runtime.

Display names, the first visitor, and the mere existence of a Social
workspace mapping are not authority. Missing or conflicting state stays
409; this tool never creates a substitute team, never mints invite codes,
and never replays history as new sends.

Operator:

  python -m flybot_workspace.social_membership_migrate plan --data-dir /data
  python -m flybot_workspace.social_membership_migrate apply --data-dir /data \\
    --social-url http://127.0.0.1:18783 \\
    --key-file /run/secrets/flybot-workspace-social-migrate.key

Use --identities-file only for attestations previously collected through
manager control. Do not build that file by matching usernames. The migrate
key and runtime cookies are never printed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

from . import invites as invite_mod
from . import members
from . import store as store_mod
from . import team_directory
from . import teams as team_mod

SCHEMA = '''
CREATE TABLE IF NOT EXISTS social_membership_migrate_receipts (
 digest TEXT PRIMARY KEY,
 snapshot_id TEXT NOT NULL,
 applied INTEGER NOT NULL,
 result TEXT NOT NULL);
'''

HEX32 = __import__('re').compile(r'^[0-9a-f]{32}$')


def stable(value):
    if value is None or isinstance(value, (str, int, bool)):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if isinstance(value, float):
        raise TypeError('floats are not allowed in a migration snapshot')
    if isinstance(value, list):
        return '[' + ','.join(stable(item) for item in value) + ']'
    if isinstance(value, dict):
        return '{' + ','.join(json.dumps(key, ensure_ascii=False) + ':' + stable(value[key])
                              for key in sorted(value)) + '}'
    raise TypeError('unsupported snapshot type')


def canonical_digest(value):
    return hashlib.sha256(stable(value).encode('utf-8')).hexdigest()


def ms(value):
    if value is None:
        return None
    number = int(value)
    return number * 1000 if 0 < number < 10 ** 12 else number


def _row(row):
    return None if row is None else dict(row)


def referenced_users(workspace):
    ids = {workspace['owner_platform_user_id']}
    for member in workspace['members']:
        ids.add(member['platform_user_id'])
        if member.get('added_by_platform_user_id'):
            ids.add(member['added_by_platform_user_id'])
    for invite in workspace['invites']:
        ids.add(invite['created_by'])
    for request in workspace['join_requests']:
        ids.add(request['platform_user_id'])
        if request.get('decided_by'):
            ids.add(request['decided_by'])
    for convo in workspace['conversations']:
        ids.update(convo['member_ids'])
        if convo.get('created_by'):
            ids.add(convo['created_by'])
        for agent in convo.get('agents', []):
            if agent.get('owner_platform_user_id'):
                ids.add(agent['owner_platform_user_id'])
        for message in convo.get('messages', []):
            if message.get('platform_user_id'):
                ids.add(message['platform_user_id'])
            if message.get('owner_platform_user_id'):
                ids.add(message['owner_platform_user_id'])
            if message.get('pinned_by'):
                ids.add(message['pinned_by'])
            for reaction in message.get('reactions', []):
                ids.add(reaction['platform_user_id'])
        ids.update(convo.get('reads', {}) or {})
        ids.update(convo.get('pins', {}) or {})
        ids.update(convo.get('mutes', {}) or {})
    return {item for item in ids if item}


def build_snapshot(db):
    """Consistent read of platform membership and history. Usernames are not keys."""
    workspaces = []
    for workspace in db.execute('SELECT * FROM workspaces ORDER BY id').fetchall():
        workspace = dict(workspace)
        listing = [dict(row) for row in members.listing(db, workspace)]
        team = _row(team_mod.load(db, workspace['id'])) if hasattr(team_mod, 'load') else None
        directory = _row(team_directory.listing(db, workspace['id']))
        member_rows = []
        for row in listing:
            added = db.execute(
                'SELECT added_by FROM workspace_members WHERE workspace_id=? AND user_id=?',
                (workspace['id'], row['user_id'])).fetchone()
            member_rows.append({
                'platform_user_id': row['user_id'],
                'role': row['role'],
                'created_at': ms(row['created']),
                'suspended': bool(row.get('suspended')),
                'added_by_platform_user_id': added['added_by'] if added else workspace['owner_id'],
            })
        invite_rows = []
        for row in db.execute('SELECT * FROM workspace_invites WHERE workspace_id=? ORDER BY id',
                              (workspace['id'],)).fetchall():
            policy = invite_mod.policy(db, row['id'])
            invite_rows.append({
                'id': row['id'],
                'token_hash': row['token_hash'],
                'role': row['role'],
                'created_at': ms(row['created']),
                'expires_at': ms(row['expires']),
                'created_by': row['created_by'],
                'max_uses': row['max_uses'],
                'use_count': row['use_count'],
                'revoked': bool(row['revoked']),
                'frozen': bool(policy.get('frozen')),
                'requires_approval': bool(policy.get('requires_approval')),
            })
        request_rows = []
        for row in db.execute('SELECT * FROM workspace_join_requests WHERE workspace_id=? ORDER BY id',
                              (workspace['id'],)).fetchall():
            request_rows.append({
                'id': row['id'],
                'invite_id': row['invite_id'],
                'platform_user_id': row['user_id'],
                'role': row['role'],
                'status': row['status'],
                'created_at': ms(row['created']),
                'decided_at': ms(row['decided']),
                'decided_by': row['decided_by'],
            })
        conversations = []
        for convo in db.execute(
                'SELECT * FROM social_conversations WHERE workspace_id=? ORDER BY id',
                (workspace['id'],)).fetchall():
            member_ids = [row['user_id'] for row in db.execute(
                'SELECT user_id FROM social_members WHERE conversation_id=? ORDER BY user_id',
                (convo['id'],)).fetchall()]
            reads, pins, mutes = {}, {}, {}
            for row in db.execute('SELECT user_id, read_seq FROM social_reads WHERE conversation_id=?',
                                  (convo['id'],)).fetchall():
                reads[row['user_id']] = row['read_seq']
            for row in db.execute('SELECT user_id, pinned FROM social_preferences WHERE conversation_id=?',
                                  (convo['id'],)).fetchall():
                if row['pinned']:
                    pins[row['user_id']] = True
            agents = []
            for row in db.execute(
                    'SELECT m.agent_id, m.created, a.name, a.created_by FROM social_agent_members m '
                    'JOIN workspace_agents a ON a.id=m.agent_id WHERE m.conversation_id=? ORDER BY m.agent_id',
                    (convo['id'],)).fetchall():
                agents.append({
                    'agent_ref': row['agent_id'],
                    'name': row['name'],
                    'owner_platform_user_id': row['created_by'] or workspace['owner_id'],
                    'created_at': ms(row['created']),
                    'auto_reply': False,
                })
            messages = []
            for row in db.execute(
                    'SELECT m.*, s.revision, s.edited, s.retracted FROM social_messages m '
                    'LEFT JOIN social_message_state s ON s.message_id=m.id '
                    'WHERE m.conversation_id=? ORDER BY m.seq, m.id',
                    (convo['id'],)).fetchall():
                reactions = [{
                    'platform_user_id': item['user_id'],
                    'emoji': item['emoji'],
                    'created_at': ms(item['created']),
                } for item in db.execute(
                    'SELECT user_id, emoji, created FROM social_reactions WHERE message_id=? ORDER BY user_id, emoji',
                    (row['id'],)).fetchall()]
                pin = db.execute('SELECT pinned_by FROM social_message_pins WHERE message_id=?',
                                 (row['id'],)).fetchone()
                messages.append({
                    'id': row['id'],
                    'seq': row['seq'],
                    'platform_user_id': row['user_id'],
                    'author_kind': 'member',
                    'body': row['body'] if not row['retracted'] else '',
                    'created_at': ms(row['created']),
                    'edited_at': ms(row['edited']),
                    'retracted': bool(row['retracted']),
                    'client_key': 'legacy:' + row['id'],
                    'reactions': reactions,
                    'pinned_by': pin['pinned_by'] if pin else None,
                })
            # Succeeded historical agent replies become messages with their recorded ids/seqs.
            # Queued or running central tasks are not imported and must not be executed again.
            for row in db.execute(
                    "SELECT * FROM social_agent_replies WHERE conversation_id=? AND status='succeeded' ORDER BY seq, id",
                    (convo['id'],)).fetchall():
                if row['seq'] is None:
                    continue
                social_id = row['id'] if HEX32.match(row['id']) else hashlib.sha256(('agent-reply:' + row['id']).encode()).hexdigest()[:32]
                messages.append({
                    'id': social_id,
                    'platform_id': row['id'],
                    'seq': row['seq'],
                    'platform_user_id': row['requested_by'],
                    'owner_platform_user_id': workspace['owner_id'],
                    'author_kind': 'agent',
                    'agent_ref': row['agent_id'],
                    'agent_name': row['agent_name'],
                    'body': row['body'],
                    'created_at': ms(row['created']),
                    'retracted': False,
                    'client_key': 'legacy-agent:' + row['id'],
                    'reactions': [],
                })
            messages.sort(key=lambda item: (item['seq'], item['id']))
            conversations.append({
                'id': convo['id'],
                'kind': convo['kind'],
                'title': convo['title'],
                'dm_key': convo['dm_key'],
                'created_at': ms(convo['created']),
                'updated_at': ms(convo['updated']),
                'created_by': (workspace['owner_id'] if workspace['owner_id'] in member_ids
                               else (sorted(member_ids)[0] if member_ids else workspace['owner_id'])),
                'member_ids': member_ids,
                'reads': reads,
                'pins': pins,
                'mutes': mutes,
                'agents': agents,
                'messages': messages,
            })
        workspaces.append({
            'workspace_id': workspace['id'],
            'name': (team['name'] if team else workspace['name']),
            'slug': team['slug'] if team else None,
            'created_at': ms(workspace['created']),
            'owner_platform_user_id': workspace['owner_id'],
            'listed': bool(directory),
            'summary': directory['summary'] if directory else '',
            'members': member_rows,
            'invites': invite_rows,
            'join_requests': request_rows,
            'conversations': conversations,
        })
    workspaces.sort(key=lambda item: item['workspace_id'])
    return {'workspaces': workspaces}


def attest_identities(db, probe):
    """Collect Social owner/home from manager-controlled runtime probes.

    ``probe(instance)`` receives a non-secret instance descriptor and must
    return a dict with social_owner_id and home_id, or a reason. Cookies and
    tokens never enter the snapshot.
    """
    accounts = {}
    conflicts = []
    unresolved = []
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='instances'").fetchone() is None:
        return {'accounts': [], 'conflicts': [], 'unresolved': [{'reason': 'runtime_schema_missing'}]}
    for row in db.execute(
            "SELECT i.id AS instance_id, i.owner_id, i.workspace_id, i.desired, i.observed, i.health, i.blocked "
            "FROM instances i ORDER BY i.owner_id, i.id").fetchall():
        instance = dict(row)
        if instance['desired'] != 'running' or instance['observed'] != 'running' or instance['health'] != 'healthy' or instance['blocked']:
            unresolved.append({'platform_user_id': instance['owner_id'], 'instance_id': instance['instance_id'],
                               'reason': 'runtime_not_ready'})
            continue
        try:
            attested = probe({
                'instance_id': instance['instance_id'],
                'platform_user_id': instance['owner_id'],
                'workspace_id': instance['workspace_id'],
            }) or {}
        except Exception as error:
            unresolved.append({'platform_user_id': instance['owner_id'], 'instance_id': instance['instance_id'],
                               'reason': 'probe_failed'})
            continue
        if not attested.get('social_owner_id') or not attested.get('home_id'):
            unresolved.append({'platform_user_id': instance['owner_id'], 'instance_id': instance['instance_id'],
                               'reason': attested.get('reason') or 'identity_unavailable'})
            continue
        if attested.get('platform_user_id') and attested['platform_user_id'] != instance['owner_id']:
            conflicts.append({'platform_user_id': instance['owner_id'], 'instance_id': instance['instance_id'],
                              'reason': 'runtime_binding_disagrees'})
            continue
        record = {
            'platform_user_id': instance['owner_id'],
            'instance_id': instance['instance_id'],
            'social_owner_id': attested['social_owner_id'],
            'home_id': attested['home_id'],
        }
        prior = accounts.get(instance['owner_id'])
        if prior and (prior['social_owner_id'] != record['social_owner_id'] or prior['home_id'] != record['home_id']):
            conflicts.append({'platform_user_id': instance['owner_id'], 'reason': 'instance_identities_disagree'})
            continue
        accounts[instance['owner_id']] = record
    # A Social owner claimed by two platform accounts is a hard conflict.
    by_social = {}
    for record in accounts.values():
        by_social.setdefault(record['social_owner_id'], []).append(record['platform_user_id'])
    for social_owner, users in by_social.items():
        if len(set(users)) > 1:
            conflicts.append({'social_owner_id': social_owner, 'reason': 'social_owner_bound_to_multiple_platform_users'})
            for user in users:
                accounts.pop(user, None)
    return {
        'accounts': [accounts[key] for key in sorted(accounts)],
        'conflicts': conflicts,
        'unresolved': unresolved,
    }


def probe_runtime(db, instance, timeout=10):
    """POST social/identity to the instance recorded by the manager. No secret logging."""
    row = db.execute(
        'SELECT address, auth_cookie FROM dsbot_upstreams WHERE instance_id=?',
        (instance['instance_id'],)).fetchone()
    if row is None:
        return {'reason': 'upstream_missing'}
    address, cookie = row['address'], row['auth_cookie']
    request = urllib.request.Request(
        f'http://{address}/api/flybot-workspace',
        data=json.dumps({'endpoint': 'social/identity', 'payload': {}}).encode('utf-8'),
        method='POST',
        headers={'Content-Type': 'application/json', 'Accept': 'application/json', 'Cookie': cookie},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode('utf-8'))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        return {'reason': 'identity_unavailable'}
    value = payload.get('value') if isinstance(payload, dict) and payload.get('ok') else None
    if not isinstance(value, dict) or not value.get('connected'):
        return {'reason': (value or {}).get('reason') or 'not_connected'}
    return {
        'social_owner_id': value.get('social_owner_id'),
        'home_id': value.get('home_id'),
        'platform_user_id': value.get('platform_user_id'),
    }


def plan(snapshot, attestation):
    accounts = {row['platform_user_id']: row for row in attestation['accounts']}
    ready, blocked = [], []
    for workspace in snapshot['workspaces']:
        missing = sorted(uid for uid in referenced_users(workspace) if uid not in accounts)
        reasons = [item for item in attestation['conflicts'] if item.get('platform_user_id') in referenced_users(workspace)
                   or item.get('reason') == 'social_owner_bound_to_multiple_platform_users']
        if missing or reasons:
            blocked.append({
                'workspace_id': workspace['workspace_id'],
                'code': 'membership_migration_required' if missing and not reasons else 'membership_migration_conflict',
                'missing_platform_user_ids': missing,
                'conflicts': reasons,
            })
        else:
            ready.append(workspace['workspace_id'])
    material_accounts = [accounts[uid] for uid in sorted({uid for workspace in snapshot['workspaces']
                         if workspace['workspace_id'] in ready for uid in referenced_users(workspace)})]
    material_workspaces = [workspace for workspace in snapshot['workspaces'] if workspace['workspace_id'] in ready]
    material = {'accounts': material_accounts, 'workspaces': material_workspaces}
    digest = canonical_digest(material) if material_workspaces else None
    return {
        'ready_workspace_ids': ready,
        'blocked': blocked,
        'material': material,
        'digest': digest,
        'conflicts': attestation['conflicts'],
        'unresolved': attestation['unresolved'],
    }


def ensure_receipts(db):
    db.executescript(SCHEMA)


def apply_plan(db, planned, *, social_url, key, snapshot_id, now):
    if planned['blocked'] and not planned['ready_workspace_ids']:
        return {'ok': False, 'code': 'membership_migration_required', 'blocked': planned['blocked']}
    if not planned['digest']:
        return {'ok': False, 'code': 'membership_migration_required', 'blocked': planned['blocked']}
    ensure_receipts(db)
    prior = db.execute('SELECT result FROM social_membership_migrate_receipts WHERE digest=?',
                       (planned['digest'],)).fetchone()
    if prior:
        return json.loads(prior['result']) | {'idempotent': True}
    body = {
        'snapshot_id': snapshot_id,
        'digest': planned['digest'],
        'accounts': planned['material']['accounts'],
        'workspaces': planned['material']['workspaces'],
    }
    request = urllib.request.Request(
        social_url.rstrip('/') + '/v1/ot/ops/membership-migrate',
        data=json.dumps(body).encode('utf-8'),
        method='POST',
        headers={'Content-Type': 'application/json', 'Accept': 'application/json',
                 'Authorization': 'Bearer ' + key},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.loads(response.read().decode('utf-8'))
            status = response.status
    except urllib.error.HTTPError as error:
        detail = error.read().decode('utf-8')
        try:
            payload = json.loads(detail)
        except json.JSONDecodeError:
            payload = {'error': {'code': 'http_%s' % error.code, 'message': 'migrate refused'}}
        return {'ok': False, 'status': error.code, 'error': payload.get('error') or payload, 'blocked': planned['blocked']}
    db.execute('INSERT OR REPLACE INTO social_membership_migrate_receipts VALUES(?,?,?,?)',
               (planned['digest'], snapshot_id, now, json.dumps({'ok': True, 'result': result})))
    return {'ok': True, 'result': result, 'blocked': planned['blocked'], 'status': status}


def load_identities_file(path):
    data = json.loads(Path(path).read_text('utf-8'))
    rows = data['accounts'] if isinstance(data, dict) and 'accounts' in data else data
    accounts = []
    for row in rows:
        if not HEX32.match(str(row.get('platform_user_id', ''))) or not HEX32.match(str(row.get('instance_id', ''))):
            raise ValueError('identities file must use manager-attested platform and instance UUIDs, not names')
        if not row.get('social_owner_id') or not row.get('home_id'):
            raise ValueError('identities file is missing social_owner_id or home_id')
        if any(key in row for key in ('username', 'display_name', 'handle')) and not row.get('social_owner_id'):
            raise ValueError('identities file cannot use display names as authority')
        accounts.append({
            'platform_user_id': row['platform_user_id'],
            'instance_id': row['instance_id'],
            'social_owner_id': row['social_owner_id'],
            'home_id': row['home_id'],
        })
    return {'accounts': accounts, 'conflicts': [], 'unresolved': []}


def load_key(path):
    text = Path(path).read_text('utf-8').strip()
    if len(text) < 32:
        raise ValueError('migrate key file is invalid')
    return text


def _public_plan(planned):
    return {
        'ready_workspace_ids': planned['ready_workspace_ids'],
        'blocked': planned['blocked'],
        'digest': planned['digest'],
        'account_count': len(planned['material']['accounts']),
        'conflicts': planned['conflicts'],
        'unresolved': planned['unresolved'],
    }



def apply_plan_outside(backend, planned, *, social_url, key):
    """Write the platform receipt in a short transaction after Social returns."""
    with backend.connect() as db:
        ensure_receipts(db)
        prior = db.execute('SELECT result FROM social_membership_migrate_receipts WHERE digest=?',
                           (planned['digest'],)).fetchone() if planned.get('digest') else None
        if prior:
            return json.loads(prior['result']) | {'idempotent': True}
    if planned['blocked'] and not planned['ready_workspace_ids']:
        return {'ok': False, 'code': 'membership_migration_required', 'blocked': planned['blocked']}
    if not planned['digest']:
        return {'ok': False, 'code': 'membership_migration_required', 'blocked': planned['blocked']}
    # HTTP happens without a platform write lock. Social itself is idempotent on digest.
    body = {
        'snapshot_id': planned['digest'],
        'digest': planned['digest'],
        'accounts': planned['material']['accounts'],
        'workspaces': planned['material']['workspaces'],
    }
    request = urllib.request.Request(
        social_url.rstrip('/') + '/v1/ot/ops/membership-migrate',
        data=json.dumps(body).encode('utf-8'),
        method='POST',
        headers={'Content-Type': 'application/json', 'Accept': 'application/json',
                 'Authorization': 'Bearer ' + key},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.loads(response.read().decode('utf-8'))
            status = response.status
    except urllib.error.HTTPError as error:
        detail = error.read().decode('utf-8')
        try:
            payload = json.loads(detail)
        except json.JSONDecodeError:
            payload = {'error': {'code': 'http_%s' % error.code, 'message': 'migrate refused'}}
        return {'ok': False, 'status': error.code, 'error': payload.get('error') or payload, 'blocked': planned['blocked']}
    with backend.transaction() as db:
        ensure_receipts(db)
        now = int(db.execute("SELECT strftime('%s','now')").fetchone()[0])
        db.execute('INSERT OR REPLACE INTO social_membership_migrate_receipts VALUES(?,?,?,?)',
                   (planned['digest'], planned['digest'], now, json.dumps({'ok': True, 'result': result})))
    return {'ok': True, 'result': result, 'blocked': planned['blocked'], 'status': status}


def main(argv=None):
    parser = argparse.ArgumentParser(prog='python -m flybot_workspace.social_membership_migrate', description=__doc__)
    parser.add_argument('command', choices=('plan', 'apply'))
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--social-url')
    parser.add_argument('--key-file')
    parser.add_argument('--identities-file', help='Manager-attested identities only; not a name map')
    parser.add_argument('--workspace', action='append', default=[], help='Limit apply to these workspace ids')
    args = parser.parse_args(argv)
    backend = store_mod.Store(args.data_dir)
    with backend.transaction() as db:
        snapshot = build_snapshot(db)
        if args.identities_file:
            attestation = load_identities_file(args.identities_file)
        else:
            attestation = attest_identities(db, lambda instance: probe_runtime(db, instance))
        planned = plan(snapshot, attestation)
        if args.workspace:
            wanted = set(args.workspace)
            planned['material']['workspaces'] = [row for row in planned['material']['workspaces'] if row['workspace_id'] in wanted]
            planned['ready_workspace_ids'] = [item for item in planned['ready_workspace_ids'] if item in wanted]
            planned['digest'] = canonical_digest(planned['material']) if planned['material']['workspaces'] else None
        if args.command == 'plan':
            json.dump(_public_plan(planned), sys.stdout, ensure_ascii=False, indent=2)
            sys.stdout.write('\n')
            return 0 if not planned['blocked'] or planned['ready_workspace_ids'] else 2
        if not args.social_url or not args.key_file:
            parser.error('apply requires --social-url and --key-file')
        key = load_key(args.key_file)
        # Close the read transaction before the HTTP apply so the lock is not held
        # for the duration of Bot Social's write.
    if args.command == 'apply':
        result = apply_plan_outside(backend, planned, social_url=args.social_url, key=key)
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write('\n')
        return 0 if result.get('ok') else 2


if __name__ == '__main__':
    sys.exit(main())
