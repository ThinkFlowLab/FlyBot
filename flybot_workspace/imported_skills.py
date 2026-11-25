"""Owner-private, immutable, bounded instruction manifests. Never unpack or execute a package."""
import hashlib
import json
import re

FORMAT = 'flybot-workspace.prompt-skill.v2'
SCHEMA = '''
CREATE TABLE IF NOT EXISTS imported_skill_versions (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 skill_id TEXT NOT NULL, version TEXT NOT NULL, manifest TEXT NOT NULL, created INTEGER NOT NULL,
 PRIMARY KEY(user_id,skill_id,version));
CREATE TABLE IF NOT EXISTS imported_skill_heads (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 skill_id TEXT NOT NULL, version TEXT NOT NULL, revision INTEGER NOT NULL,
 active INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(user_id,skill_id));
'''

class PackageError(ValueError):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def validate(value):
    required = {'id','name','version','content','format','permissions'}
    if not isinstance(value,dict) or not required <= set(value) or set(value)-required-{'digest','source'}:
        raise PackageError(400,'Only a declarative instruction manifest is accepted; no URLs, files, archives, hooks or tools')
    if (not isinstance(value['id'],str) or not re.fullmatch(r'import-[a-z0-9][a-z0-9-]{1,39}',value['id'])
            or not isinstance(value['name'],str) or not 1 <= len(value['name'].strip()) <= 120
            or not isinstance(value['version'],str) or not re.fullmatch(r'(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})',value['version'])
            or not isinstance(value['content'],str) or not 1 <= len(value['content']) <= 6000
            or any(ord(c)<32 and c not in '\n\r\t' for c in value['content']+value['name'])
            or any(0xd800 <= ord(c) <= 0xdfff for c in value['content']+value['name'])
            or value['permissions'] != ['model_context'] or value['format'] != FORMAT
            or value.get('source','user-imported') != 'user-imported'):
        raise PackageError(400,'Use an import- ID, bounded text, x.y.z version, v2 format and only model_context permission')
    digest = hashlib.sha256(value['content'].encode()).hexdigest()
    if 'digest' in value and value['digest'] != digest:
        raise PackageError(409,'Content digest does not match; inspect the package before importing')
    return {k:value[k] for k in ('id','name','version','content','format','permissions')} | {'digest':digest,'source':'user-imported'}


def catalogue(db,uid):
    rows = db.execute('''SELECT v.manifest FROM imported_skill_heads h JOIN imported_skill_versions v
      ON v.user_id=h.user_id AND v.skill_id=h.skill_id AND v.version=h.version
      WHERE h.user_id=? AND h.active=1 ORDER BY h.skill_id''',(uid,)).fetchall()
    return [json.loads(r['manifest']) for r in rows]


def metadata(db,uid,ident):
    head = db.execute('SELECT * FROM imported_skill_heads WHERE user_id=? AND skill_id=?',(uid,ident)).fetchone()
    if not head:
        return None
    versions = db.execute('SELECT version,manifest,created FROM imported_skill_versions WHERE user_id=? AND skill_id=? ORDER BY created DESC,rowid DESC',(uid,ident)).fetchall()
    return {'id':ident,'revision':head['revision'],'active':bool(head['active']),'version':head['version'],
            'versions':[{'version':v['version'],'digest':json.loads(v['manifest'])['digest'],'created':v['created']} for v in versions]}


def save(db,uid,value,revision,consent,now):
    item = validate(value)
    if type(revision) is not int or revision < 0 or consent is not True:
        raise PackageError(400,'Provide the current revision and explicitly consent to untrusted model-context content')
    prior = metadata(db,uid,item['id'])
    if (prior['revision'] if prior else 0) != revision:
        raise PackageError(409,'Package changed in another tab; reload before importing')
    old = db.execute('SELECT manifest FROM imported_skill_versions WHERE user_id=? AND skill_id=? AND version=?',(uid,item['id'],item['version'])).fetchone()
    encoded = json.dumps(item,ensure_ascii=False,sort_keys=True)
    if old and old['manifest'] != encoded:
        raise PackageError(409,'Versions are immutable; increase the version instead of replacing its contents')
    if prior and tuple(map(int,item['version'].split('.'))) <= tuple(map(int,prior['version'].split('.'))):
        if old and old['manifest']==encoded and prior['active'] and item['version']==prior['version']:
            return item,prior
        raise PackageError(409,'Import a newer version; revoked versions cannot silently regain availability')
    if not prior and db.execute('SELECT COUNT(*) FROM imported_skill_heads WHERE user_id=?',(uid,)).fetchone()[0] >= 25:
        raise PackageError(429,'Maximum 25 private imported packages per user')
    if prior and len(prior['versions']) >= 10:
        raise PackageError(429,'Maximum 10 immutable versions per package')
    db.execute('INSERT INTO imported_skill_versions VALUES(?,?,?,?,?)',(uid,item['id'],item['version'],encoded,now))
    db.execute('INSERT INTO imported_skill_heads VALUES(?,?,?,?,1,?) ON CONFLICT(user_id,skill_id) DO UPDATE SET version=excluded.version,revision=excluded.revision,active=1,updated=excluded.updated',(uid,item['id'],item['version'],revision+1,now))
    return item,metadata(db,uid,item['id'])


def revoke(db,uid,ident,revision,now):
    prior = metadata(db,uid,ident)
    if prior is None:
        raise PackageError(404,'Package not found')
    if type(revision) is not int or revision != prior['revision']:
        raise PackageError(409,'Package changed; reload before revoking')
    if prior['active']:
        db.execute('UPDATE imported_skill_heads SET active=0,revision=revision+1,updated=? WHERE user_id=? AND skill_id=?',(now,uid,ident))
        db.execute('DELETE FROM skill_bindings WHERE user_id=? AND skill_id=?',(uid,ident))
    return metadata(db,uid,ident)
