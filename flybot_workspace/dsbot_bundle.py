"""Per-user, per-feature import bundles for the DS-Bot plugin (docs/DSBOT_PLUGIN_ARCHITECTURE.md §5).

The platform exports only the rows of one account (workspaces that account
owns) for one moved feature. Each table is serialised as one canonical JSON
string and its SHA-256 is recorded in the manifest, so the plugin importer
(runtime/flybot-workspace-web/src/features/importer.js) verifies exactly the bytes
the platform hashed. Delivery into the user's volume is the manager job's
concern; this module never writes into any runtime and never includes secrets.
Legacy rows are not modified.
"""
import hashlib
import json
import time

FORMAT = 'flybot-workspace-dsbot-import'

# feature -> ordered [(table, SQL selecting that user's rows; every ? = user id)].
_OWNED = 'SELECT id FROM workspaces WHERE owner_id = ?'
_MEMORY_USERS = (
    "SELECT u.id, u.username, CASE WHEN u.id = ? THEN 1 ELSE 0 END AS is_owner FROM users u WHERE u.id = ? "
    "OR u.id IN (SELECT created_by FROM memory_pages WHERE workspace_id IN (" + _OWNED + ")) "
    "OR u.id IN (SELECT updated_by FROM memory_pages WHERE workspace_id IN (" + _OWNED + ")) "
    "OR u.id IN (SELECT created_by FROM memory_page_versions WHERE workspace_id IN (" + _OWNED + ")) "
    "OR u.id IN (SELECT created_by FROM memory_actions WHERE workspace_id IN (" + _OWNED + ")) "
    "OR u.id IN (SELECT updated_by FROM memory_actions WHERE workspace_id IN (" + _OWNED + ")) "
    "OR u.id IN (SELECT created_by FROM memory_links WHERE workspace_id IN (" + _OWNED + ")) ORDER BY u.id")


def _scoped(table, order='id'):
    return 'SELECT * FROM ' + table + ' WHERE workspace_id IN (' + _OWNED + ') ORDER BY ' + order

_ARTIFACT_USERS = (
    "SELECT u.id, u.username, CASE WHEN u.id = ? THEN 1 ELSE 0 END AS is_owner FROM users u WHERE u.id = ? "
    "OR u.id IN (SELECT created_by FROM artifacts WHERE workspace_id IN (" + _OWNED + ")) "
    "OR u.id IN (SELECT updated_by FROM artifacts WHERE workspace_id IN (" + _OWNED + ")) "
    "OR u.id IN (SELECT v.created_by FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id "
    "WHERE a.workspace_id IN (" + _OWNED + ")) "
    "OR u.id IN (SELECT created_by FROM artifact_shares WHERE workspace_id IN (" + _OWNED + ")) "
    "OR u.id IN (SELECT user_id FROM artifact_favorites f JOIN artifacts a ON a.id=f.artifact_id "
    "WHERE a.workspace_id IN (" + _OWNED + ")) ORDER BY u.id")


def _via_artifact(table, order):
    return ('SELECT x.* FROM ' + table + ' x JOIN artifacts a ON a.id=x.artifact_id '
            'WHERE a.workspace_id IN (' + _OWNED + ') ORDER BY ' + order)



# Parents come before children; the plugin imports in its own declared order.
FEATURE_TABLES = {
    'message-assists': [('message_assists', "SELECT a.*, t.status AS task_status, CASE WHEN json_valid(t.result) THEN json_extract(t.result,'$.text') ELSE NULL END AS result_text FROM message_assists a LEFT JOIN runtime_tasks t ON t.id=a.task_id AND t.user_id=a.user_id WHERE a.user_id=? ORDER BY a.created,a.id")],
    'skills': [
        ('imported_skill_heads', 'SELECT * FROM imported_skill_heads WHERE user_id=? ORDER BY skill_id'),
        ('imported_skill_versions', 'SELECT * FROM imported_skill_versions WHERE user_id=? ORDER BY skill_id,created,version'),
        ('skill_bindings', 'SELECT * FROM skill_bindings WHERE user_id=? ORDER BY scope,skill_id'),
        ('skill_installs', 'SELECT * FROM skill_installs WHERE user_id=? ORDER BY installed,skill_id'),
    ],
    'skill-run-history': [('skill_run_history', """
        SELECT r.task_id AS id, r.scope, r.skill_id, t.prompt, t.status,
               t.created, t.updated, COALESCE(m.acknowledged, 0) AS loaded,
               CASE WHEN t.status='succeeded' AND json_valid(t.result) THEN
                    CASE WHEN json_type(t.result, '$.text')='text'
                         THEN json_extract(t.result, '$.text') END
               END AS result_text
        FROM skill_runs r
        JOIN runtime_tasks t ON t.id=r.task_id AND t.user_id=r.user_id
        LEFT JOIN skill_task_material m ON m.task_id=t.id
        WHERE r.user_id=? AND t.status IN ('succeeded','failed')
        ORDER BY t.created,t.id
    """)],
    'skill-secrets': [('skill_secrets', 'SELECT name,updated FROM skill_secrets WHERE user_id=? ORDER BY name')],
    'meetings': [
        ('meetings', 'SELECT m.* FROM meetings m JOIN workspaces w ON w.id = m.workspace_id '
                     'WHERE w.owner_id = ? ORDER BY m.id'),
    ],
    'memory': [
        ('ot_users', _MEMORY_USERS),
        ('memory_pages', _scoped('memory_pages')),
        ('memory_page_versions', _scoped('memory_page_versions', 'page_id, revision')),
        ('memory_page_topics', _scoped('memory_page_topics', 'page_id, name_hash')),
        ('memory_links', _scoped('memory_links')),
        ('memory_actions', _scoped('memory_actions')),
        ('memory_suggestions', _scoped('memory_suggestions')),
        # Profile and preferences are personal: only this account's own rows.
        ('memory_profiles', 'SELECT * FROM memory_profiles WHERE user_id = ? ORDER BY workspace_id'),
        ('memory_preferences', 'SELECT * FROM memory_preferences WHERE user_id = ? ORDER BY workspace_id, position, id'),
    ],
    'artifacts': [
        ('ot_users', _ARTIFACT_USERS),
        ('artifacts', _scoped('artifacts')),
        ('artifact_favorites', _via_artifact('artifact_favorites', 'x.artifact_id, x.user_id')),
        ('artifact_meta', _via_artifact('artifact_meta', 'x.artifact_id')),
        ('artifact_sources', _scoped('artifact_sources', 'artifact_id')),
        ('artifact_shares', _scoped('artifact_shares')),
        ('artifact_media', _via_artifact('artifact_media', 'x.artifact_id')),
        ('artifact_boards', _via_artifact('artifact_boards', 'x.artifact_id')),
        ('artifact_slides', _via_artifact('artifact_slides', 'x.artifact_id')),
        ('artifact_dashboards', _via_artifact('artifact_dashboards', 'x.artifact_id')),
        ('artifact_chat_sources', _scoped('artifact_chat_sources', 'artifact_id')),
        ('artifact_versions', _via_artifact('artifact_versions', 'x.artifact_id, x.revision')),
    ],
}



# Stream B2 (automations, agents). Queued automation runs are exported so the
# plugin can mark those slots skipped and not fire them again; the platform
# must also stop the legacy scheduler for this user at the same cutover.
FEATURE_TABLES.update({
    'automations': [
        ('automations', _scoped('automations')),
        ('automation_editors',
         'SELECT e.* FROM automation_editors e JOIN automations a ON a.id = e.automation_id '
         'WHERE a.workspace_id IN (' + _OWNED + ') ORDER BY e.automation_id'),
        ('automation_runs',
         'SELECT r.* FROM automation_runs r JOIN automations a ON a.id = r.automation_id '
         'WHERE a.workspace_id IN (' + _OWNED + ') ORDER BY r.id'),
    ],
    'agents': [
        ('personal_agents', 'SELECT * FROM personal_agents WHERE user_id=? ORDER BY agent_id'),
        ('workspace_agents', _scoped('workspace_agents')),
        ('workspace_agent_categories',
         'SELECT c.* FROM workspace_agent_categories c JOIN workspace_agents a ON a.id = c.agent_id '
         'WHERE a.workspace_id IN (' + _OWNED + ') ORDER BY c.agent_id'),
        ('workspace_agent_quick_starts',
         'SELECT q.* FROM workspace_agent_quick_starts q JOIN workspace_agents a ON a.id = q.agent_id '
         'WHERE a.workspace_id IN (' + _OWNED + ') ORDER BY q.agent_id, q.position'),
        ('agent_conversations', _scoped('agent_conversations')),
        ('agent_messages',
         'SELECT m.* FROM agent_messages m JOIN agent_conversations c ON c.id = m.conversation_id '
         'WHERE c.workspace_id IN (' + _OWNED + ') ORDER BY m.conversation_id, m.seq, m.id'),
    ],
})

# Stream B4 (settings, model-api, connectors). Secret columns are never
# selected here: key blobs travel only through sealed_secrets() below.
FEATURE_TABLES.update({
    'settings': [
        ('user_settings', 'SELECT user_id, document, revision, updated FROM user_settings WHERE user_id = ?'),
        ('user_onboarding', 'SELECT * FROM user_onboarding WHERE user_id = ?'),
        ('user_onboarding_steps', 'SELECT * FROM user_onboarding_steps WHERE user_id = ?'),
    ],
    'model-api': [
        ('model_api_configs', "SELECT id, provider, base_url, model, revision, updated, "
                              "CASE WHEN key_blob IS NULL OR key_blob = '' THEN 0 ELSE 1 END AS key_set "
                              "FROM model_api_configs WHERE scope = 'account' AND account_id = ?"),
    ],
    'connectors': [
        ('composio_user', "SELECT 'flybot-workspace-' || id AS user_ref FROM users WHERE id = ?"),
        ('composio_keys', 'SELECT user_id, key_hint, revision, updated FROM composio_keys WHERE user_id = ?'),
        ('composio_connections', 'SELECT id, toolkit, account_id, status, status_reason, created, updated '
                                 'FROM composio_connections WHERE user_id = ? ORDER BY created, id'),
        ('custom_mcp_servers', 'SELECT id, name, origin, revision, created, updated '
                               'FROM custom_mcp_servers WHERE user_id = ? ORDER BY created, id'),
    ],
})


def canonical(rows):
    return json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _artifact_media(db, user_id, data_dir):
    """Content-addressed media objects this account owns, as canonical JSON rows."""
    import base64
    from pathlib import Path
    cursor = db.execute(
        'SELECT a.workspace_id, md.sha256, md.byte_count FROM artifact_media md '
        'JOIN artifacts a ON a.id=md.artifact_id WHERE a.workspace_id IN (' + _OWNED + ') '
        'UNION SELECT a.workspace_id, v.sha256, v.byte_count FROM artifact_versions v '
        'JOIN artifacts a ON a.id=v.artifact_id WHERE a.workspace_id IN (' + _OWNED + ') '
        'AND v.sha256 IS NOT NULL ORDER BY 1, 2',
        (user_id, user_id),
    )
    items = []
    root = Path(data_dir) / 'artifact-objects'
    for workspace_id, digest, byte_count in cursor.fetchall():
        path = root / workspace_id / digest
        payload = path.read_bytes()
        if len(payload) != byte_count:
            raise ValueError('media size mismatch')
        items.append({'workspace_id': workspace_id, 'sha256': digest, 'byte_count': byte_count,
                      'data': base64.b64encode(payload).decode('ascii')})
    return items


def build(db, user_id, feature, now=None, data_dir=None):
    """Return the bundle dict for one user and one feature."""
    if feature not in FEATURE_TABLES:
        raise ValueError('unknown feature')
    if not isinstance(user_id, str) or not user_id:
        raise ValueError('user id required')
    tables, manifest = {}, {}
    for table, sql in FEATURE_TABLES[feature]:
        cursor = db.execute(sql, (user_id,) * sql.count('?'))
        names = [column[0] for column in cursor.description]
        rows = [dict(zip(names, tuple(row))) for row in cursor.fetchall()]
        text = canonical(rows)
        tables[table] = text
        manifest[table] = {'rows': len(rows), 'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()}
    bundle = {'format': FORMAT, 'version': 1, 'feature': feature,
              'created': int(time.time() if now is None else now), 'tables': tables, 'manifest': manifest}
    if feature == 'artifacts' and data_dir is not None:
        media = _artifact_media(db, user_id, data_dir)
        text = canonical(media)
        bundle['media'] = text
        bundle['manifest']['media'] = {'rows': len(media), 'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()}
    return bundle


def build_personal_bootstrap(db, user_id, instance_id, now):
    """Seed the initial roster and welcome message for an auto-provisioned DS-Bot."""
    from .security import digest
    binding = db.execute('SELECT * FROM personal_agents WHERE user_id=?', (user_id,)).fetchone()
    if binding is None:
        return None
    workspace = binding['workspace_id']
    roster = db.execute(
        'SELECT a.* FROM workspace_agents a LEFT JOIN builtin_agents b ON b.agent_id=a.id '
        'WHERE a.workspace_id=? AND (a.id=? OR b.workspace_id=?) ORDER BY a.id',
        (workspace, binding['agent_id'], workspace)).fetchall()
    welcome = db.execute(
        'SELECT * FROM agent_conversations WHERE workspace_id=? AND agent_id=? AND key_hash=?',
        (workspace, binding['agent_id'], digest('personal-conversation:' + user_id))).fetchone()
    messages = db.execute(
        'SELECT * FROM agent_messages WHERE conversation_id=? AND seq=1 AND role=?',
        (welcome['id'], 'assistant')).fetchall() if welcome else []
    builtins = db.execute(
        'SELECT agent_id, workspace_id, builtin_key FROM builtin_agents WHERE workspace_id=? ORDER BY agent_id',
        (workspace,)).fetchall()
    raw = {'personal_agents': [binding], 'workspace_agents': roster, 'builtin_agents': builtins,
           'agent_conversations': [welcome] if welcome else [], 'agent_messages': messages}
    tables = {name: canonical([dict(row) for row in rows]) for name, rows in raw.items()}
    manifest = {name: {'rows': len(raw[name]), 'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()}
                for name, text in tables.items()}
    return {'format': FORMAT, 'version': 1, 'feature': 'agents', 'instance_id': instance_id,
            'created': now, 'tables': tables, 'manifest': manifest}


def dumps(bundle):
    return json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sealed_secrets(db, store, user_id, feature, seal_key):
    """B4 secrets of one account, re-wrapped for one target runtime.

    seal_key is the 32-byte key the manager delivers to that runtime as
    FLYBOT_WORKSPACE_SEAL_KEY_FILE; values use the model_api.wrap format that the
    plugin's lib/b4/seal.js unwrapLegacy() reads, then re-seals on its volume.
    Plain values exist only in this process. Composio keys stay per-user: only
    this account's own key is ever exported.
    """
    from . import composio, custom_mcp, model_api
    if not isinstance(seal_key, (bytes, bytearray)) or len(seal_key) != 32:
        raise ValueError('32-byte runtime seal key required')
    out = {}
    if feature == 'model-api':
        row = model_api.load_account(db, user_id)
        if row is not None and row['key_blob']:
            out['model_api_key'] = model_api.wrap(bytes(seal_key), model_api.secret(store, row))
    elif feature == 'skill-secrets':
        from . import skill_secrets
        rows = db.execute('SELECT name,key_blob FROM skill_secrets WHERE user_id=? ORDER BY name', (user_id,)).fetchall()
        if rows:
            key = skill_secrets.wrapping_key(store)
            for row in rows:
                out['secret:' + row['name']] = model_api.wrap(bytes(seal_key), model_api.unwrap(key, row['key_blob']))
    elif feature == 'connectors':
        key = composio.user_key(store, db, user_id)
        if key:
            out['composio_key'] = model_api.wrap(bytes(seal_key), key)
        for row in db.execute('SELECT * FROM custom_mcp_servers WHERE user_id = ? ORDER BY created, id', (user_id,)).fetchall():
            out['mcp:' + row['id']] = model_api.wrap(bytes(seal_key), json.dumps(custom_mcp.secret_config(store, row)))
    return out


def build_with_secrets(db, store, user_id, feature, seal_key=None, now=None):
    """build() plus, for B4 features, sealed secrets and their digest."""
    bundle = build(db, user_id, feature, now)
    if seal_key is not None and feature in ('model-api', 'connectors', 'skill-secrets'):
        secrets = sealed_secrets(db, store, user_id, feature, seal_key)
        bundle['seal_key_id'] = hashlib.sha256(bytes(seal_key)).hexdigest()
        bundle['secrets'] = secrets
        bundle['secrets_sha256'] = hashlib.sha256(canonical(secrets).encode('utf-8')).hexdigest()
    return bundle
