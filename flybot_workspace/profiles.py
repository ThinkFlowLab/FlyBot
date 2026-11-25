"""Self-service account profiles and a public handle projection.

The account owns its avatar, identity fields, and private life goals.
The public projection omits goals, email, and account IDs.
"""
import hashlib
import json
import re
from html import escape
from urllib.parse import urlsplit

from . import artifacts

SCHEMA = '''
CREATE TABLE IF NOT EXISTS user_profiles (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 handle TEXT NOT NULL,
 handle_lower TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 bio TEXT NOT NULL,
 tags TEXT NOT NULL,
 gender TEXT NOT NULL CHECK(gender IN ('','male','female','other')),
 location TEXT NOT NULL,
 website TEXT NOT NULL,
 goals TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS user_profile_handle ON user_profiles(handle_lower);
CREATE TABLE IF NOT EXISTS user_avatars (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg')),
 byte_count INTEGER NOT NULL CHECK(byte_count >= 1 AND byte_count <= 2097152),
 sha256 TEXT NOT NULL,
 filename TEXT NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS user_avatar_digest ON user_avatars(sha256);
'''

NAME_MAX = 40
HANDLE_MIN, HANDLE_MAX = 3, 30
BIO_MAX = 200
TAG_MAX = 8
TAG_LEN = 20
LOCATION_MAX = 80
WEBSITE_MAX = 200
GOAL_MAX = 200
GOALS = ('health', 'finance', 'career', 'hobbies', 'family', 'productivity', 'other')
# Avatars reuse the artifact object store (content-addressed bytes under
# <data-dir>/artifact-objects/, private directories and 0600 files). Only the
# MIME and the digest are kept in the database.
AVATAR_MIMES = ('image/png', 'image/jpeg')
AVATAR_MAX = artifacts.MAX_MEDIA_BYTES
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
HANDLE = re.compile(r'[a-z0-9](?:[a-z0-9._]{1,28})[a-z0-9]')
RESERVED = {
    'admin', 'api', 'settings', 'team', 'profile', 'chat', 'agents', 'discover',
    'memory', 'space', 'download', 'pricing', 'login', 'logout', 'support',
    'help', 'about', 'me', 'u', 'p', 'v1', 'new', 'edit', 'share', 'install',
    'shell', 'runtimes', 'members', 'contacts', 'automations', 'artifacts', 'guide',
}


def valid_handle(value):
    return (isinstance(value, str) and HANDLE_MIN <= len(value) <= HANDLE_MAX
            and bool(HANDLE.fullmatch(value)) and '..' not in value
            and value not in RESERVED)


def valid_name(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= NAME_MAX and not CONTROL.search(value)


def valid_bio(value):
    return isinstance(value, str) and len(value) <= BIO_MAX and not CONTROL.search(value)


def valid_location(value):
    return isinstance(value, str) and len(value.strip()) <= LOCATION_MAX and not CONTROL.search(value)


def valid_website(value):
    if value == '':
        return True
    if not isinstance(value, str) or len(value) > WEBSITE_MAX or CONTROL.search(value):
        return False
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return (parsed.scheme in ('http', 'https') and bool(parsed.hostname)
            and not parsed.username and not parsed.password)


def valid_tags(value):
    if not isinstance(value, list) or len(value) > TAG_MAX:
        return False
    seen = set()
    for tag in value:
        if not isinstance(tag, str) or not 1 <= len(tag.strip()) <= TAG_LEN or CONTROL.search(tag):
            return False
        key = tag.strip().casefold()
        if key in seen:
            return False
        seen.add(key)
    return True


def valid_goals(value):
    if not isinstance(value, dict):
        return False
    for key, text in value.items():
        if key not in GOALS or not isinstance(text, str) or len(text.strip()) > GOAL_MAX:
            return False
        if CONTROL.search(text):
            return False
    return True


def valid_gender(value):
    return value in ('', 'male', 'female', 'other')


def sanitize_handle(username):
    text = re.sub(r'[^a-z0-9._]+', '.', (username or '').lower())
    text = re.sub(r'\.{2,}', '.', text).strip('.')
    if len(text) < HANDLE_MIN:
        text = (text + 'user')[:HANDLE_MAX]
    text = text[:HANDLE_MAX].strip('.')
    return text or 'user'


def _tags(raw):
    try:
        value = json.loads(raw) if raw else []
    except ValueError:
        return []
    return value if isinstance(value, list) else []


def _goals(raw):
    try:
        value = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def view(row):
    return {
        'handle': row['handle'],
        'name': row['name'],
        'bio': row['bio'],
        'tags': _tags(row['tags']),
        'gender': row['gender'],
        'location': row['location'],
        'website': row['website'],
        'goals': _goals(row['goals']),
        'revision': row['revision'],
        'created': row['created'],
        'updated': row['updated'],
    }


def public_view(row):
    return {
        'handle': row['handle'],
        'name': row['name'],
        'bio': row['bio'],
        'tags': _tags(row['tags']),
        'gender': row['gender'],
        'location': row['location'],
        'website': row['website'],
        'created': row['created'],
    }


PAGE_CSP = ("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; "
            "form-action 'none'; frame-ancestors 'none'; object-src 'none'")
GENDER_LABELS = {'male': '男', 'female': '女', 'other': '其他', '': '未设置'}


def render_page(row):
    name = escape(row['name'] or row['handle'])
    handle = escape(row['handle'])
    bio = escape(row['bio'] or '')
    location = escape(row['location'] or '')
    website = row['website'] or ''
    website_html = ''
    if website:
        href = escape(website, quote=True)
        website_html = '<p class="meta">网站：<a href="' + href + '" rel="nofollow noopener noreferrer">' + href + '</a></p>'
    tags = _tags(row['tags'])
    tags_html = ''
    if tags:
        tags_html = '<ul class="tags">' + ''.join('<li>' + escape(tag) + '</li>' for tag in tags) + '</ul>'
    location_html = '<p class="meta">所在地：' + location + '</p>' if location else ''
    gender = GENDER_LABELS.get(row['gender'], '未设置')
    return (
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="referrer" content="no-referrer">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<title>' + name + ' · FlyBot</title>'
        '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",'
        '"Noto Sans SC",sans-serif;background:#f6f7f9;color:#0f172a;margin:0;padding:2rem 1rem}'
        '.card{max-width:44rem;margin:0 auto;background:#fff;border:1px solid #e2e6ec;'
        'border-radius:1.25rem;box-shadow:0 12px 32px rgba(15,23,42,.08);padding:1.5rem 1.75rem}'
        '.avatar{width:3.5rem;height:3.5rem;border-radius:999px;display:grid;place-items:center;'
        'background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;font-weight:700;font-size:1.4rem}'
        'h1{margin:.75rem 0 .15rem;font-size:1.6rem}.handle{color:#5b6675;margin:0 0 1rem}'
        '.bio{white-space:pre-wrap;line-height:1.6}.meta{color:#5b6675;margin:.35rem 0}'
        '.tags{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:.4rem;margin:1rem 0 0}'
        '.tags li{background:#eef1ff;color:#4338ca;border-radius:999px;padding:.15rem .6rem;font-size:.8rem}'
        'a{color:#4f46e5}</style></head><body><main class="card">'
        '<div class="avatar">' + escape((row['name'] or row['handle'])[:2].upper()) + '</div>'
        '<h1>' + name + '</h1><p class="handle">@' + handle + '</p>'
        '<p class="bio">' + bio + '</p>' + location_html +
        '<p class="meta">性别：' + escape(gender) + '</p>' + website_html + tags_html +
        '</main></body></html>'
    )


def load(db, user_id):
    return db.execute('SELECT * FROM user_profiles WHERE user_id=?', (user_id,)).fetchone()


def load_handle(db, handle_lower):
    return db.execute('SELECT * FROM user_profiles WHERE handle_lower=?', (handle_lower,)).fetchone()


def avatar_namespace(user_id):
    """Object namespace for one account's avatar.

    Artifact garbage collection only ever scans real workspace ids, so a
    namespace derived from the user id cannot be removed by deleting an
    artifact that happens to carry the same bytes.
    """
    return hashlib.sha256(('profile-avatar:' + user_id).encode('utf-8')).hexdigest()[:32]


def load_avatar(db, user_id):
    return db.execute('SELECT * FROM user_avatars WHERE user_id=?', (user_id,)).fetchone()


def avatar_view(row):
    if row is None:
        return None
    return {
        'url': '/v1/profile/avatar?v=' + row['sha256'][:12],
        'mime': row['mime'],
        'bytes': row['byte_count'],
        'updated': row['updated'],
    }


def default_handle(db, username):
    base = sanitize_handle(username)
    candidate = base
    for index in range(1, 1000):
        if valid_handle(candidate) and load_handle(db, candidate) is None:
            return candidate
        suffix = '-%d' % index
        candidate = (base[:HANDLE_MAX - len(suffix)] + suffix).strip('.')
    return None


def serialize_tags(tags):
    return json.dumps([tag.strip() for tag in tags], ensure_ascii=False, separators=(',', ':'))


def serialize_goals(goals):
    return json.dumps({key: goals[key].strip() for key in GOALS if goals.get(key, '').strip()},
                      ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def normalize_changes(changes):
    if not isinstance(changes, dict) or not changes:
        return None
    out = {}
    if 'handle' in changes:
        handle = changes['handle'].strip().lower() if isinstance(changes['handle'], str) else ''
        if not valid_handle(handle):
            return None
        out['handle'] = handle
    if 'name' in changes:
        if not valid_name(changes['name']):
            return None
        out['name'] = changes['name'].strip()
    if 'bio' in changes:
        if not valid_bio(changes['bio']):
            return None
        out['bio'] = changes['bio'].strip()
    if 'tags' in changes:
        if not valid_tags(changes['tags']):
            return None
        out['tags'] = [tag.strip() for tag in changes['tags']]
    if 'gender' in changes:
        if not valid_gender(changes['gender']):
            return None
        out['gender'] = changes['gender']
    if 'location' in changes:
        if not valid_location(changes['location']):
            return None
        out['location'] = changes['location'].strip()
    if 'website' in changes:
        value = changes['website'].strip() if isinstance(changes['website'], str) else ''
        if not valid_website(value):
            return None
        out['website'] = value
    if 'goals' in changes:
        if not valid_goals(changes['goals']):
            return None
        out['goals'] = {key: value.strip() for key, value in changes['goals'].items()}
    return out
