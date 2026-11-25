"""Write-only skill secrets (per account). Names are uppercase, digits, and underscore."""
import re

import os
import stat

from . import model_api

SCHEMA = '''
CREATE TABLE IF NOT EXISTS skill_secrets (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 key_blob BLOB NOT NULL,
 updated INTEGER NOT NULL,
 PRIMARY KEY (user_id, name));
'''

NAME = re.compile(r'[A-Z][A-Z0-9_]{0,63}')
MAX_SECRETS = 50


def valid_name(value):
    return type(value) is str and NAME.fullmatch(value)


def valid_value(value):
    return type(value) is str and 1 <= len(value) <= 4096


def wrapping_key(store):
    path = store.path.parent / 'skill-secrets.wrap'
    flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Skill secret wrapping key must be a private regular file')
        key = os.read(fd, 64)
        if len(key) == 0:
            import secrets
            key = secrets.token_bytes(32)
            os.write(fd, key)
        elif len(key) != 32:
            raise ValueError('Skill secret wrapping key is the wrong size')
        return key
    finally:
        os.close(fd)


def list_secrets(db, user_id):
    rows = db.execute(
        'SELECT name, updated FROM skill_secrets WHERE user_id=? ORDER BY name', (user_id,)
    ).fetchall()
    return {'items': [{'name': row['name'], 'updated': row['updated']} for row in rows]}


def put_secret(db, store, user_id, name, value, now):
    count = db.execute('SELECT COUNT(*) FROM skill_secrets WHERE user_id=?', (user_id,)).fetchone()[0]
    exists = db.execute(
        'SELECT name FROM skill_secrets WHERE user_id=? AND name=?', (user_id, name)
    ).fetchone()
    if exists is None and count >= MAX_SECRETS:
        raise ValueError('quota')
    blob = model_api.wrap(wrapping_key(store), value)
    db.execute(
        'INSERT INTO skill_secrets VALUES(?,?,?,?) ON CONFLICT(user_id, name) DO UPDATE SET '
        'key_blob=excluded.key_blob, updated=excluded.updated',
        (user_id, name, blob, now),
    )


def delete_secret(db, user_id, name):
    return db.execute(
        'DELETE FROM skill_secrets WHERE user_id=? AND name=?', (user_id, name)
    ).rowcount
