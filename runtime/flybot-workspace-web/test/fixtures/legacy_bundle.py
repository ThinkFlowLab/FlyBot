"""Build DS-Bot import bundles from retained platform rows for fixture accounts."""
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from flybot_workspace import artifacts, dsbot_bundle, memory  # noqa: E402
from flybot_workspace.store import Store  # noqa: E402


NOW = 1800000000


def seed_meetings(db, actor, owner, workspace, index):
    meeting = str(5 + index) * 32
    title = '周会' if actor == 'alice' else 'bob 的会'
    db.execute('INSERT INTO meetings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
               (meeting, workspace, title, '9' * 64, NOW, json.dumps([actor]), '讨论排期。',
                '同步进度。', json.dumps([{'text': '订会议室', 'owner': actor, 'done': False}]),
                1, NOW, NOW, owner, owner, 'a' * 64, 'b' * 64))
    return {'meeting_id': meeting, 'title': title}


def seed_artifacts(db, actor, owner, workspace, index):
    artifact = str(5 + index) * 32
    title = '周报' if actor == 'alice' else 'bob 的文档'
    body = '本周完成迁移。' if actor == 'alice' else 'x'
    db.execute('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
               (artifact, workspace, title, artifacts.title_hash(title), 'document', body,
                1, NOW, NOW, owner, owner, 'a' * 64, 'b' * 64))
    artifacts.record_version(db, artifacts.load(db, workspace, artifact))
    return {'artifact_id': artifact, 'title': title, 'body': body}


def seed_memory(db, actor, owner, workspace, index):
    page = str(5 + index) * 32
    title = '客户偏好' if actor == 'alice' else 'bob 的记忆'
    body = '喜欢简洁的周报，周五发。' if actor == 'alice' else 'x'
    revision = 2 if actor == 'alice' else 1
    db.execute('INSERT INTO memory_pages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
               (page, workspace, title, memory.title_hash(title), body, revision,
                NOW, NOW + revision - 1, owner, owner, 'a' * 64, 'b' * 64))
    if actor == 'alice':
        memory.replace_topics(db, workspace, page, ['客户'])
        memory.record_version(db, workspace, page, 1, title, '喜欢简洁的周报。', NOW, owner)
    return {'page_id': page, 'title': title, 'body': body, 'revision': revision}


SEEDS = {'memory': seed_memory, 'artifacts': seed_artifacts, 'meetings': seed_meetings}


def main(features):
    with tempfile.TemporaryDirectory() as temp:
        store = Store(Path(temp).resolve() / 'state')
        own_id, own_workspace = '1' * 32, '3' * 32
        expect = {'workspace_id': own_workspace}
        with store.transaction() as db:
            for index, actor in enumerate(('alice', 'bob')):
                owner = str(1 + index) * 32
                workspace = str(3 + index) * 32
                db.execute('INSERT INTO users VALUES(?,?,?,?)', (owner, actor, 'fixture-only', NOW))
                db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?)',
                           (workspace, owner, actor, NOW, '7' * 64, '8' * 64))
                for feature in features:
                    result = SEEDS[feature](db, actor, owner, workspace, index)
                    if index == 0:
                        expect[feature] = result
                    else:
                        expect[feature]['foreign_title'] = result['title']
        with store.connect() as db:
            bundles = {feature: dsbot_bundle.dumps(dsbot_bundle.build(db, own_id, feature, now=NOW, data_dir=store.data_dir))
                       for feature in features}
        print(json.dumps({'bundles': bundles, 'expect': expect}, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1:])
