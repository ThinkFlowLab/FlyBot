"""Operator CLI for reserving capacity without removing any account runtime data."""

import argparse
import json
import time

from .lifecycle import ID, RuntimeFault
from .operator_config import load_auto_provision
from .runtime_autoprovision import capacity_status, set_parked
from .store import Store


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--auto-provision', required=True)
    commands = parser.add_subparsers(dest='action', required=True)
    commands.add_parser('status', help='Show the current reservation counts')
    for action in ('park', 'restore'):
        command = commands.add_parser(action, help=f'{action.capitalize()} a stopped account runtime reservation')
        command.add_argument('instance_id')
        command.add_argument('--revision', type=int, required=True)
    args = parser.parse_args()
    if args.action != 'status' and (not ID.fullmatch(args.instance_id) or args.revision < 1):
        parser.error('Provide a valid instance ID and positive revision')
    try:
        policy = load_auto_provision(args.auto_provision)
        store = Store(args.data_dir)
        if args.action == 'status':
            with store.connect() as db:
                result = capacity_status(db, policy)
        else:
            with store.transaction() as db:
                changed = set_parked(db, policy, args.instance_id, args.revision,
                                     args.action == 'park', int(time.time()))
                result = {'changed': changed, **capacity_status(db, policy)}
    except RuntimeFault as error:
        parser.exit(1, f'{error.code}: {error.message}\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
