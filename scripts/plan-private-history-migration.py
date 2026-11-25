#!/usr/bin/env python3
"""Compare a legacy private-chat volume and its owner's provisioned DS-Bot.

Use consistent snapshots as inputs. The optional private output is a payload
for the destination runtime's existing agents/adopt-personal-chat operation.
"""
import argparse
from contextlib import closing, ExitStack
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

ID = re.compile(r'[0-9a-f]{32}')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_database(path):
    db = sqlite3.connect(path.resolve(strict=True).as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('BEGIN')
    return closing(db)


def timestamp(value):
    require(type(value) is int and value > 0, 'Invalid source timestamp')
    return value // 1000 if value > 10**12 else value


def plan(management, legacy_volume, canonical_volume, source_instance, destination_instance):
    require(ID.fullmatch(source_instance) and ID.fullmatch(destination_instance)
            and source_instance != destination_instance, 'Expected two distinct runtime IDs')
    with ExitStack() as stack:
        platform = stack.enter_context(read_database(management))
        source = platform.execute('SELECT owner_id,volume_ref FROM instances WHERE id=?', (source_instance,)).fetchone()
        target = platform.execute('SELECT owner_id,volume_ref FROM instances WHERE id=?', (destination_instance,)).fetchone()
        require(source and target and source['owner_id'] == target['owner_id'], 'Runtimes must belong to the same account')
        require(source['volume_ref'] == 'ot-' + source_instance and target['volume_ref'] == 'ot-' + destination_instance,
                'Unexpected registered volume identity')
        provision = platform.execute('SELECT instance_id,workspace_id,agent_id FROM runtime_auto_provisions WHERE user_id=?',
                                     (source['owner_id'],)).fetchone()
        require(provision and provision['instance_id'] == destination_instance, 'Destination is not the provisioned runtime')
        binding = (provision['workspace_id'], provision['agent_id'])
        require(all(ID.fullmatch(value) for value in binding), 'Invalid provisioned workspace or agent')
        require(legacy_volume.resolve(strict=True) != canonical_volume.resolve(strict=True), 'Expected different volumes')
        volume_ids = set()
        for volume, iid in ((legacy_volume, source_instance), (canonical_volume, destination_instance)):
            identity = json.loads((volume / 'flybot-workspace' / 'instance.json').read_text())
            volume_id = identity.get('instance_id')
            require(isinstance(volume_id, str) and ID.fullmatch(volume_id)
                    and identity.get('routingInstanceId') in (None, iid), 'Invalid persisted runtime identity')
            volume_ids.add(volume_id)
        require(len(volume_ids) == 2, 'Volumes carry the same runtime identity')
        legacy_root = legacy_volume / 'flybot-workspace' / 'features'
        target_root = canonical_volume / 'flybot-workspace' / 'features'
        chat = stack.enter_context(read_database(legacy_root / 'chat' / 'chat.sqlite3'))
        old_agents = stack.enter_context(read_database(legacy_root / 'agents' / 'agents.sqlite3'))
        agents = stack.enter_context(read_database(target_root / 'agents' / 'agents.sqlite3'))
        actual = agents.execute('SELECT workspace_id,agent_id FROM native_personal_binding WHERE singleton=1').fetchone()
        require(actual is not None and tuple(actual) == binding, 'Destination personal binding differs from platform provision')
        actual_agent = agents.execute('SELECT workspace_id,archived FROM agents WHERE id=?', (binding[1],)).fetchone()
        require(actual_agent and actual_agent['workspace_id'] == binding[0] and not actual_agent['archived'],
                'Destination personal agent is unavailable in its provisioned workspace')

        saved = chat.execute("SELECT value FROM chat_state WHERE key='native_personal_binding'").fetchone()
        prior_binding = json.loads(saved['value']) if saved else None
        old_binding = old_agents.execute('SELECT workspace_id,agent_id FROM native_personal_binding WHERE singleton=1').fetchone()
        summary = {'missing_conversations': 0, 'missing_messages': 0, 'existing_conversations': 0,
                   'existing_messages': 0, 'existing_on_historical_agents': 0}
        payload = {'workspace_id': binding[0], 'id': binding[1], 'conversations': []}
        require(chat.execute('SELECT 1 FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id '
                             'WHERE c.id IS NULL LIMIT 1').fetchone() is None, 'Source contains orphaned messages')
        for row in chat.execute('SELECT * FROM conversations ORDER BY created,id'):
            convo = dict(row)
            cid = convo['id']
            require(ID.fullmatch(cid) and isinstance(convo['title'], str) and 0 < len(convo['title']) <= 120,
                    'Invalid source conversation')
            timestamp(convo['created'])
            timestamp(convo['updated'])
            old = old_agents.execute('SELECT agent_id FROM agent_conversations WHERE id=?', (cid,)).fetchone()
            present = agents.execute('SELECT agent_id FROM agent_conversations WHERE id=?', (cid,)).fetchone()
            if present:
                require(present['agent_id'] == (old['agent_id'] if old else binding[1]),
                        'An existing conversation has a different recorded owner')
                summary['existing_conversations'] += 1
                if present['agent_id'] != binding[1]:
                    summary['existing_on_historical_agents'] += 1
            else:
                require(not old or old['agent_id'] == binding[1], 'A missing conversation already has a historical agent')
                require(not prior_binding or (prior_binding.get('workspace_id'), prior_binding.get('agent_id')) == binding,
                        'A missing conversation has a different recorded private-chat binding')
                require(not old_binding or tuple(old_binding) == binding,
                        'A missing conversation has a different recorded personal binding')
                summary['missing_conversations'] += 1
            convo['messages'] = []
            for item in chat.execute('SELECT * FROM messages WHERE conversation_id=? ORDER BY created,id', (cid,)):
                message = dict(item)
                stamp = timestamp(message['created'])
                require(ID.fullmatch(message['id']) and message['role'] in ('user', 'assistant')
                        and isinstance(message['text'], str), 'Invalid source message')
                message['meta'] = json.loads(message['meta'])
                require(isinstance(message['meta'], dict), 'Invalid source message metadata')
                found = agents.execute('SELECT conversation_id,role,text,created FROM agent_messages WHERE id=?',
                                       (message['id'],)).fetchone()
                if present:
                    require(found is not None and tuple(found) == (cid, message['role'], message['text'], stamp),
                            'An existing conversation has missing or differing message data')
                    summary['existing_messages'] += 1
                else:
                    require(found is None, 'A missing conversation already has a message ID in use')
                    summary['missing_messages'] += 1
                    convo['messages'].append(message)
            if not present:
                payload['conversations'].append(convo)
        return payload, summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--management', required=True, type=Path)
    parser.add_argument('--legacy-volume', required=True, type=Path)
    parser.add_argument('--canonical-volume', required=True, type=Path)
    parser.add_argument('--source-instance', required=True)
    parser.add_argument('--destination-instance', required=True)
    parser.add_argument('--output', type=Path, help='Create a new private file containing the adoption payload')
    args = parser.parse_args()
    try:
        payload, summary = plan(args.management, args.legacy_volume, args.canonical_volume,
                                args.source_instance, args.destination_instance)
        if args.output:
            fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as out:
                json.dump(payload, out, ensure_ascii=False, separators=(',', ':'))
                out.write('\n')
        print(json.dumps(summary, sort_keys=True))
    except (OSError, ValueError, sqlite3.Error, TypeError, KeyError) as error:
        sys.exit(str(error))


if __name__ == '__main__':
    main()
