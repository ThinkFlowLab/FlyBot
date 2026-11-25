"""Per-account interface preferences (issue #4, domain 10).

Self-written for FlyBot; no upstream or Teamily source. Option semantics
follow the 2026-11-16 Teamily contrasts (rounds 1 and 2). Teamily does not
expose locale codes; the codes below are our mapping of the recaptured labels.
Custom appearance period fields were not captured; start/end stay as HH:MM
and are unverified. Still not settings parity.
"""
import json
import re

SCHEMA = '''
CREATE TABLE IF NOT EXISTS user_settings (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 document TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1), updated INTEGER NOT NULL);
'''

# Codes are FlyBot mappings of labels recaptured from Teamily's lists.
LANGUAGES = (
    'en', 'fa', 'fr', 'de', 'es', 'it', 'pt-BR', 'ru',
    'id', 'ms', 'hi', 'bn', 'th', 'ja', 'ko', 'zh-HK', 'zh-TW', 'zh-CN',
)
CHAT_LANGUAGES = (
    'en', 'fa', 'fr', 'de', 'es', 'pt', 'it', 'ru',
    'id', 'vi', 'bn', 'th', 'ar', 'ja', 'ko', 'zh-Hant', 'zh-CN',
)
TIME = re.compile(r'(?:[01]\d|2[0-3]):[0-5]\d')

# A prompt cannot use the stored code: the model is told the language by name.
CHAT_LANGUAGE_NAMES = {
    'en': 'English', 'fa': 'Persian', 'fr': 'French', 'de': 'German', 'es': 'Spanish',
    'pt': 'Portuguese', 'it': 'Italian', 'ru': 'Russian', 'id': 'Indonesian',
    'vi': 'Vietnamese', 'bn': 'Bengali', 'th': 'Thai', 'ar': 'Arabic', 'ja': 'Japanese',
    'ko': 'Korean', 'zh-Hant': 'Traditional Chinese', 'zh-CN': 'Simplified Chinese',
}

# name -> (allowed values or kind, default). Booleans use (True, False).
FIELDS = {
    'appearance': (('system', 'light', 'dark', 'auto'), 'system'),
    'appearance_schedule': (('sunset_sunrise', 'custom'), 'sunset_sunrise'),
    'appearance_start': ('time', '18:00'),
    'appearance_end': ('time', '07:00'),
    'language': (LANGUAGES, 'zh-CN'),
    'chat_language': (('auto',) + CHAT_LANGUAGES, 'auto'),
    'auto_translate': ((True, False), False),
    'send_shortcut': (('enter', 'mod_enter'), 'enter'),
    'message_folding': (('compact', 'standard', 'none'), 'standard'),
    'document_cards': ((True, False), False),
    'link_previews': ((True, False), True),
    'task_completion_reminders': ((True, False), True),
    'likes_visible': ((True, False), True),
    'favorites_visible': ((True, False), True),
}


def defaults():
    return {name: default for name, (_, default) in FIELDS.items()}


def valid_value(name, value):
    allowed, _ = FIELDS[name]
    if allowed == 'time':
        return type(value) is str and TIME.fullmatch(value)
    if isinstance(allowed[0], bool):
        return type(value) is bool
    return type(value) is str and value in allowed


def migrate(stored):
    """Map a previously stored document onto current keys. Unknown keys stay dropped."""
    result = {}
    if not isinstance(stored, dict):
        return result
    stored = dict(stored)
    if 'message_folding' not in stored and 'fold_long_messages' in stored:
        flag = stored['fold_long_messages']
        if flag is True:
            stored['message_folding'] = 'standard'
        elif flag is False:
            stored['message_folding'] = 'none'
    for old_name, new_name in (('likes_visibility', 'likes_visible'),
                               ('favorites_visibility', 'favorites_visible')):
        if new_name not in stored and old_name in stored:
            flag = stored[old_name]
            if flag == 'everyone':
                stored[new_name] = True
            elif flag == 'private':
                stored[new_name] = False
    for name, value in stored.items():
        if name in FIELDS and valid_value(name, value):
            result[name] = value
    return result


def view(row):
    """Return the stored document merged over defaults; unknown/invalid stored keys are ignored."""
    result = defaults()
    revision = 0
    if row is not None:
        revision = row['revision']
        try:
            stored = json.loads(row['document'])
        except ValueError:
            stored = {}
        result.update(migrate(stored))
    return {'values': result, 'revision': revision}


def chat_language_name(code):
    """The language name a prompt can use. 'auto' and unknown codes name nothing."""
    return CHAT_LANGUAGE_NAMES.get(code) if isinstance(code, str) else None


def stored_chat_language(db, user_id):
    """The reply language this account stored, read at the moment a message is sent."""
    row = db.execute('SELECT * FROM user_settings WHERE user_id=?', (user_id,)).fetchone()
    return view(row)['values']['chat_language']


def normalize_changes(changes):
    """Validate a write payload. Accepts the retired fold_long_messages boolean as an alias."""
    if not isinstance(changes, dict) or not changes:
        return None
    if 'fold_long_messages' in changes and 'message_folding' in changes:
        return None
    result = {}
    for name, value in changes.items():
        if name == 'fold_long_messages':
            if type(value) is not bool:
                return None
            result['message_folding'] = 'standard' if value else 'none'
            continue
        if name in ('likes_visibility', 'favorites_visibility'):
            if value not in ('everyone', 'private'):
                return None
            result['likes_visible' if name == 'likes_visibility' else 'favorites_visible'] = value == 'everyone'
            continue
        if name not in FIELDS or not valid_value(name, value):
            return None
        result[name] = value
    return result
