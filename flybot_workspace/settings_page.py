"""Same-origin management pages for the /v1 APIs (settings and automations).

Serves only an exact asset allowlist. API security stays in App; this wrapper
does not interpret /v1 routes. Self-written; no upstream or Teamily source.
"""
from hashlib import sha256
import os
import re
from pathlib import Path
import stat
from urllib.parse import parse_qsl, urlsplit

from . import discover


_OPAQUE_ETAG = r'"[\x21\x23-\x7e\x80-\xff]*"'
_ETAG_LIST = re.compile(rf'(?:W/)?{_OPAQUE_ETAG}(?:[ \t]*,[ \t]*(?:W/)?{_OPAQUE_ETAG})*')
_ETAG_VALUES = re.compile(_OPAQUE_ETAG)


def _matches_asset_etag(value, opaque_tag):
    value = value.strip(' \t')
    if value == '*':
        return True
    return bool(_ETAG_LIST.fullmatch(value) and opaque_tag in _ETAG_VALUES.findall(value))


class SettingsPage:
    ASSETS = {
        '/login': ('home', 'index.html', 'text/html; charset=utf-8'),
        '/runtime-starting': ('home', 'runtime-starting.html', 'text/html; charset=utf-8'),
        '/home/runtime-starting.mjs': ('home', 'runtime-starting.mjs', 'text/javascript; charset=utf-8'),
        '/home/runtime-readiness.mjs': ('home', 'runtime-readiness.mjs', 'text/javascript; charset=utf-8'),
        '/register': ('register', 'index.html', 'text/html; charset=utf-8'),
        '/register/': ('register', 'index.html', 'text/html; charset=utf-8'),
        '/register/app.mjs': ('register', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/register/app.css': ('register', 'app.css', 'text/css; charset=utf-8'),
        '/settings': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/appearance': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/language': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/message-folding': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/privacy': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/shortcuts': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/channels': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/agent-access': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/connectors': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/skill-configuration': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/custom-mcp.mjs': ('settings', 'custom-mcp.mjs', 'text/javascript; charset=utf-8'),
        '/settings/connected-tools.mjs': ('settings', 'connected-tools.mjs', 'text/javascript; charset=utf-8'),
        '/settings/app.mjs': ('settings', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/settings/app.css': ('settings', 'app.css', 'text/css; charset=utf-8'),
        '/automations': ('automations', 'index.html', 'text/html; charset=utf-8'),
        '/automations/app.mjs': ('automations', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/automations/studio-share.mjs': ('automations', 'studio-share.mjs', 'text/javascript; charset=utf-8'),
        '/automations/app.css': ('automations', 'app.css', 'text/css; charset=utf-8'),
        '/team': ('team', 'index.html', 'text/html; charset=utf-8'),
        '/new/team': ('team', 'index.html', 'text/html; charset=utf-8'),
        '/team/app.mjs': ('team', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/team/app.css': ('team', 'app.css', 'text/css; charset=utf-8'),
        '/contacts': ('contacts', 'index.html', 'text/html; charset=utf-8'),
        '/contacts/app.mjs': ('contacts', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/contacts/app.css': ('contacts', 'app.css', 'text/css; charset=utf-8'),
        '/members': ('members', 'index.html', 'text/html; charset=utf-8'),
        '/members/app.mjs': ('members', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/members/group-invite.mjs': ('members', 'group-invite.mjs', 'text/javascript; charset=utf-8'),
        '/members/app.css': ('members', 'app.css', 'text/css; charset=utf-8'),
        '/artifacts': ('artifacts', 'index.html', 'text/html; charset=utf-8'),
        '/artifacts/app.mjs': ('artifacts', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/artifacts/entry.mjs': ('artifacts', 'entry.mjs', 'text/javascript; charset=utf-8'),
        '/artifacts/notifications.mjs': ('artifacts', 'notifications.mjs', 'text/javascript; charset=utf-8'),
        '/artifacts/shared-studio.mjs': ('artifacts', 'shared-studio.mjs', 'text/javascript; charset=utf-8'),
        '/artifacts/studio-copy.mjs': ('artifacts', 'studio-copy.mjs', 'text/javascript; charset=utf-8'),
        '/artifacts/studio-personal-copy.mjs': ('artifacts', 'studio-personal-copy.mjs', 'text/javascript; charset=utf-8'),
        '/artifacts/shared-work-copy.mjs': ('artifacts', 'shared-work-copy.mjs', 'text/javascript; charset=utf-8'),
        '/artifacts/version-preview.mjs': ('artifacts', 'version-preview.mjs', 'text/javascript; charset=utf-8'),
        '/artifacts/studio-discussion.mjs': ('artifacts', 'studio-discussion.mjs', 'text/javascript; charset=utf-8'),
        '/artifacts/studio-history.mjs': ('artifacts', 'studio-history.mjs', 'text/javascript; charset=utf-8'),
        '/artifacts/studio-merge.mjs': ('artifacts', 'studio-merge.mjs', 'text/javascript; charset=utf-8'),
        '/artifacts/app.css': ('artifacts', 'app.css', 'text/css; charset=utf-8'),
        '/space': ('artifacts', 'index.html', 'text/html; charset=utf-8'),
        '/agents': ('agents', 'index.html', 'text/html; charset=utf-8'),
        '/agents/app.mjs': ('agents', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/agents/app.css': ('agents', 'app.css', 'text/css; charset=utf-8'),
        '/memory': ('memory', 'index.html', 'text/html; charset=utf-8'),
        '/memory/candidates.mjs': ('memory', 'candidates.mjs', 'text/javascript; charset=utf-8'),
        '/memory/action-review.mjs': ('memory', 'action-review.mjs', 'text/javascript; charset=utf-8'),
        '/memory/app.mjs': ('memory', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/memory/rich.mjs': ('memory', 'rich.mjs', 'text/javascript; charset=utf-8'),
        '/memory/app.css': ('memory', 'app.css', 'text/css; charset=utf-8'),
        '/shell/app.css': ('shell', 'app.css', 'text/css; charset=utf-8'),
        '/shell/flybot-logo.svg': ('shell', 'flybot-logo.svg', 'image/svg+xml'),
        '/shell/app.mjs': ('shell', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/shell/system-locale.mjs': ('shell', 'system-locale.mjs', 'text/javascript; charset=utf-8'),
        '/shell/system-locale-catalog.mjs': ('shell', 'system-locale-catalog.mjs', 'text/javascript; charset=utf-8'),
        '/shell/system-locale-chat.mjs': ('shell', 'system-locale-chat.mjs', 'text/javascript; charset=utf-8'),
        '/shell/markdown.mjs': ('shell', 'markdown.mjs', 'text/javascript; charset=utf-8'),
        '/shell/markdown-table.mjs': ('shell', 'markdown-table.mjs', 'text/javascript; charset=utf-8'),
        '/shell/rich-editor.mjs': ('shell', 'rich-editor.mjs', 'text/javascript; charset=utf-8'),
        '/shell/model3d-preview.mjs': ('shell', 'model3d-preview.mjs', 'text/javascript; charset=utf-8'),
        '/shell/model3d-viewer.mjs': ('shell', 'model3d-viewer.mjs', 'text/javascript; charset=utf-8'),
        '/shell/model3d-engine-0.187.0.mjs': ('shell', 'model3d-engine-0.187.0.mjs', 'text/javascript; charset=utf-8'),
        '/shell/thumb.mjs': ('shell', 'thumb.mjs', 'text/javascript; charset=utf-8'),
        '/shell/studio-link.mjs': ('shell', 'studio-link.mjs', 'text/javascript; charset=utf-8'),
        '/shell/chat-utils.mjs': ('shell', 'chat-utils.mjs', 'text/javascript; charset=utf-8'),
        '/shell/agent-categories.mjs': ('shell', 'agent-categories.mjs', 'text/javascript; charset=utf-8'),
        '/shell/work-topics.mjs': ('shell', 'work-topics.mjs', 'text/javascript; charset=utf-8'),
        '/shell/action-menu.mjs': ('shell', 'action-menu.mjs', 'text/javascript; charset=utf-8'),
        '/shell/meeting-link.mjs': ('shell', 'meeting-link.mjs', 'text/javascript; charset=utf-8'),
        '/shell/call-audio-handoff.mjs': ('shell', 'call-audio-handoff.mjs', 'text/javascript; charset=utf-8'),
        '/shell/action-followup-events.mjs': ('shell', 'action-followup-events.mjs', 'text/javascript; charset=utf-8'),
        '/shell/work-notification.mjs': ('shell', 'work-notification.mjs', 'text/javascript; charset=utf-8'),
        '/shell/public-agent-composer.mjs': ('shell', 'public-agent-composer.mjs', 'text/javascript; charset=utf-8'),
        '/shell/public-agent-link.mjs': ('shell', 'public-agent-link.mjs', 'text/javascript; charset=utf-8'),
        '/shell/public-agent-share.mjs': ('shell', 'public-agent-share.mjs', 'text/javascript; charset=utf-8'),
        '/shell/public-work-link.mjs': ('shell', 'public-work-link.mjs', 'text/javascript; charset=utf-8'),
        '/shell/discover-link.mjs': ('shell', 'discover-link.mjs', 'text/javascript; charset=utf-8'),
        '/shell/team-invite-link.mjs': ('shell', 'team-invite-link.mjs', 'text/javascript; charset=utf-8'),
        '/shell/group-invite-link.mjs': ('shell', 'group-invite-link.mjs', 'text/javascript; charset=utf-8'),
        '/shell/dsbot-api.mjs': ('shell', 'dsbot-api.mjs', 'text/javascript; charset=utf-8'),
        '/chat': ('chat', 'index.html', 'text/html; charset=utf-8'),
        '/chat/prompt-templates.mjs': ('chat', 'prompt-templates.mjs', 'text/javascript; charset=utf-8'),
        '/chat/utilities.mjs': ('chat', 'utilities.mjs', 'text/javascript; charset=utf-8'),
        '/chat/group-management.mjs': ('chat', 'group-management.mjs', 'text/javascript; charset=utf-8'),
        '/chat/group-invite-link.mjs': ('chat', 'group-invite-link.mjs', 'text/javascript; charset=utf-8'),
        '/chat/stickers.mjs': ('chat', 'stickers.mjs', 'text/javascript; charset=utf-8'),
        '/chat/activity.mjs': ('chat', 'activity.mjs', 'text/javascript; charset=utf-8'),
        '/chat/app.mjs': ('chat', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/chat/startup.mjs': ('chat', 'startup.mjs', 'text/javascript; charset=utf-8'),
        '/chat/public-draft.mjs': ('chat', 'public-draft.mjs', 'text/javascript; charset=utf-8'),
        '/chat/video-create.mjs': ('chat', 'video-create.mjs', 'text/javascript; charset=utf-8'),
        '/chat/voice.mjs': ('chat', 'voice.mjs', 'text/javascript; charset=utf-8'),
        '/chat/mentions.mjs': ('chat', 'mentions.mjs', 'text/javascript; charset=utf-8'),
        '/chat/dsbot.mjs': ('chat', 'dsbot.mjs', 'text/javascript; charset=utf-8'),
        '/chat/app.css': ('chat', 'app.css', 'text/css; charset=utf-8'),
        '/discover': ('discover', 'index.html', 'text/html; charset=utf-8'),
        '/discover/app.mjs': ('discover', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/discover/document-reader.mjs': ('discover', 'document-reader.mjs', 'text/javascript; charset=utf-8'),
        '/discover/comments.mjs': ('discover', 'comments.mjs', 'text/javascript; charset=utf-8'),
        '/discover/app.css': ('discover', 'app.css', 'text/css; charset=utf-8'),
        '/meetings': ('meetings', 'index.html', 'text/html; charset=utf-8'),
        '/meetings/app.mjs': ('meetings', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/meetings/audio.mjs': ('meetings', 'audio.mjs', 'text/javascript; charset=utf-8'),
        '/meetings/discussion.mjs': ('meetings', 'discussion.mjs', 'text/javascript; charset=utf-8'),
        '/meetings/app.css': ('meetings', 'app.css', 'text/css; charset=utf-8'),
        '/profile': ('profile', 'index.html', 'text/html; charset=utf-8'),
        '/profile/edit': ('profile', 'index.html', 'text/html; charset=utf-8'),
        '/profile/app.mjs': ('profile', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/profile/social.mjs': ('profile', 'social.mjs', 'text/javascript; charset=utf-8'),
        '/onboarding': ('onboarding', 'index.html', 'text/html; charset=utf-8'),
        '/onboarding/app.mjs': ('onboarding', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/onboarding/app.css': ('onboarding', 'app.css', 'text/css; charset=utf-8'),
        '/profile/app.css': ('profile', 'app.css', 'text/css; charset=utf-8'),
        '/download': ('download', 'index.html', 'text/html; charset=utf-8'),
        '/download/app.mjs': ('download', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/guide': ('guide', 'index.html', 'text/html; charset=utf-8'),
        '/guide/app.mjs': ('guide', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/guide/app.css': ('guide', 'app.css', 'text/css; charset=utf-8'),
        '/about': ('about', 'index.html', 'text/html; charset=utf-8'),
        '/about/app.css': ('about', 'app.css', 'text/css; charset=utf-8'),
        '/look/app.mjs': ('look', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/look/app.css': ('look', 'app.css', 'text/css; charset=utf-8'),
        '/look/assistant-portraits.webp': ('look', 'assistant-portraits.webp', 'image/webp'),
        '/look/assistant-notebook.webp': ('look', 'assistant-notebook.webp', 'image/webp'),
        '/look/assistant-accessories.webp': ('look', 'assistant-accessories.webp', 'image/webp'),
        '/skills': ('skills', 'index.html', 'text/html; charset=utf-8'),
        '/skills/imports.mjs': ('skills', 'imports.mjs', 'text/javascript; charset=utf-8'),
        '/skills/execution.mjs': ('skills', 'execution.mjs', 'text/javascript; charset=utf-8'),
        '/skills/app.mjs': ('skills', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/skills/app.css': ('skills', 'app.css', 'text/css; charset=utf-8'),
        '/help': ('help', 'index.html', 'text/html; charset=utf-8'),
        '/terms': ('terms', 'index.html', 'text/html; charset=utf-8'),
        '/privacy': ('privacy', 'index.html', 'text/html; charset=utf-8'),
        '/docs/app.css': ('docs', 'app.css', 'text/css; charset=utf-8'),
        '/': ('home', 'index.html', 'text/html; charset=utf-8'),
        '/home': ('home', 'index.html', 'text/html; charset=utf-8'),
        '/home/app.mjs': ('home', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/home/app.css': ('home', 'app.css', 'text/css; charset=utf-8'),
        '/home/auth.css': ('home', 'auth.css', 'text/css; charset=utf-8'),
    }
    PREFIXES = ('/register', '/settings', '/automations', '/team', '/new', '/contacts', '/members', '/artifacts', '/space', '/agents', '/memory', '/shell', '/chat', '/messenger', '/discover', '/onboarding', '/profile', '/meetings', '/download', '/guide', '/about', '/skills', '/home', '/help', '/terms', '/privacy', '/docs')
    CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
           "img-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; "
           "frame-ancestors 'none'; object-src 'none'")

    def __init__(self, api):
        self.api = api
        self.root = Path(__file__).absolute().parent / 'static'

    @property
    def config(self):
        return self.api.config

    @config.setter
    def config(self, value):
        self.api.config = value


    def _asset(self, directory, name):
        # Never resolve user input into a filename. Reject symlinks, including the asset directory.
        engine = directory == 'shell' and name.startswith('model3d-engine-') and name.endswith('.mjs')
        chat_entry = directory == 'chat' and name == 'app.mjs'
        limit = 1024 * 1024 if engine or chat_entry else 256 * 1024
        folder = self.root / directory
        root_fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                    raise OSError('Invalid asset')
                with os.fdopen(fd, 'rb', closefd=False) as file:
                    data = file.read(limit + 1)
                if len(data) > limit:
                    raise OSError('Invalid asset')
                return data
            finally:
                os.close(fd)
        finally:
            os.close(root_fd)

    def _unknown_page(self, path):
        return any(path == prefix or path.startswith(prefix + '/') for prefix in self.PREFIXES)

    def _query_allowed(self, path, query):
        # Only recorded HTML query allowlists may pass. CSS/JS and every
        # other management page still reject QUERY_STRING.
        if not query:
            return True
        if path in ('/space', '/artifacts'):
            # A result link selects a record; the API still authorizes every read.
            # Match the complete raw pair: no duplicates, extras, encoded keys,
            # traversal, or queries on the CSS/JS assets can slip through.
            identifier = r'[0-9a-f]{32}'
            if re.fullmatch(rf'workspace={identifier}&artifact={identifier}|artifact={identifier}&workspace={identifier}', query):
                return True
            if re.fullmatch(rf'workspace={identifier}&studio={identifier}|studio={identifier}&workspace={identifier}', query):
                return True
            if re.fullmatch(rf'workspace={identifier}&studio={identifier}&studio_revision=[1-9][0-9]{{0,15}}', query):
                return True
            # new=<kind> opens that 新建 editor (chat composer 创建 grid).
            return query in ('view=created', 'view=starred', 'view=memory', 'view=meetings',
                             'new=document', 'new=website', 'new=slides', 'new=dashboard',
                             'new=whiteboard')
        if path == '/automations':
            # template=<id> opens the editor prefilled from a known template;
            # runs=<filter> keeps the run-history filter shareable. The two are
            # one-shot and permanent respectively, so they never share a URL.
            if query in ('runs=all', 'runs=succeeded', 'runs=failed'):
                return True
            from .automations import TEMPLATES
            template = query[len('template='):] if query.startswith('template=') else ''
            return template in TEMPLATES and template != 'custom'
        if path == '/discover':
            pairs = parse_qsl(query, keep_blank_values=True)
            filters = dict(pairs)
            if filters.get('tab') == 'agents':
                if len(filters) != len(pairs) or not all(filters.values()):
                    return False
                text = filters.get('q', '')
                if 'section' in filters:
                    return (filters['section'] == 'groups' and filters.keys() <= {'tab', 'section', 'q'}
                            and len(text) <= 60 and not any(ord(ch) < 32 for ch in text))
                return (filters.keys() <= {'tab', 'category', 'q', 'creator'}
                        and ('creator' not in filters or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{1,79}', filters['creator']))
                        and ('category' not in filters or filters['category'] in discover.AGENT_CATEGORY_SLUGS)
                        and len(text) <= 80 and not any(ord(ch) < 32 for ch in text))
            # Feed filters and work detail links use the same management page.
            seen = set()
            for key, value in pairs:
                if key in seen or not value:
                    return False
                seen.add(key)
                if key == 'work' and not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,28}[a-z0-9]', value):
                    return False
                if key in ('comments', 'share') and value != '1':
                    return False
                if key == 'feed' and value not in ('following', 'collected'):
                    return False
                if key == 'sort' and value != 'popular':
                    return False
                if key == 'kind' and value not in ('document', 'website', 'whiteboard', 'image', 'audio', 'slides',
                                                       'video', 'dashboard', 'spreadsheet', 'model3d'):
                    return False
                if key == 'creator' and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{1,79}', value):
                    return False
                if key == 'topic' and not re.fullmatch(r'[a-z][a-z0-9-]{1,19}', value):
                    return False
                if key == 'q':
                    if len(value) > 80 or any(ord(ch) < 32 for ch in value):
                        return False
                elif key not in ('feed', 'kind', 'sort', 'creator', 'topic', 'work', 'comments', 'share'):
                    return False
            panels = seen.intersection({'comments', 'share'})
            return (bool(seen)
                    and not ('sort' in seen and seen.intersection({'feed', 'kind', 'creator'}))
                    and len(panels) <= 1
                    and (not panels or 'work' in seen))
        if path == '/agents':
            if query in ('tab=teams', 'tab=teams&new=1'):
                return True
            slug = query[len('category='):] if query.startswith('category=') else ''
            return slug in discover.AGENT_CATEGORY_SLUGS
        if path == '/memory':
            # The memory directory and reply citations open exact records. Only
            # accept the URL shapes produced by those pages. Each read still
            # goes through the user's authenticated runtime.
            identifier = r'[0-9a-f]{32}'
            workspace = rf'workspace={identifier}'
            views = r'page=(?:profile|todos|candidates)'
            if re.fullmatch(rf'{views}(?:&{workspace})?|{workspace}(?:&{views})?', query):
                return True
            origin = rf'(?:&from={identifier}(?:\.{identifier}){{2,3}})?'
            citation = rf'(?:page=profile|page=todos&action={identifier}|page={identifier}(?:&revision=[1-9][0-9]{{0,7}})?)'
            return bool(re.fullmatch(rf'{workspace}&{citation}{origin}', query))
        if path == '/guide':
            # Deep links: one non-empty q, one non-empty category, or both, each
            # named at most once. An unknown category id is served anyway and the
            # page falls back to 全部, so a stale link is not a 400. Every other
            # /guide query, and every query on the guide CSS/JS, still answers 400.
            pairs = parse_qsl(query, keep_blank_values=True)
            seen = set()
            for key, value in pairs:
                if key not in ('q', 'category') or not value or key in seen:
                    return False
                seen.add(key)
            return bool(seen)
        return False

    def __call__(self, env, start_response):
        path = env.get('PATH_INFO', '')
        messenger_alias = path in ('/messenger', '/messenger/')
        if path not in self.ASSETS and not messenger_alias:
            if self._unknown_page(path):
                start_response('404 Not Found', [('Content-Type', 'text/plain; charset=utf-8'),
                                                 ('Cache-Control', 'no-store'),
                                                 ('Content-Length', '9')])
                return [] if env.get('REQUEST_METHOD') == 'HEAD' else [b'Not found']
            return self.api(env, start_response)
        audio_page = path in ('/chat', '/chat/', '/meetings')
        csp = self.CSP + "; media-src 'self' blob:" if audio_page else self.CSP
        if path == '/discover':
            csp += "; media-src 'self'"
        if path in ('/chat', '/chat/', '/space', '/artifacts', '/discover'):
            csp = csp.replace("connect-src 'self'", "connect-src 'self' blob:").replace("img-src 'self'", "img-src 'self' blob:")
        microphone = '(self)' if audio_page else '()'
        cache_control = 'no-store'
        headers = [('X-Content-Type-Options', 'nosniff'),
                   ('Content-Security-Policy', csp), ('Referrer-Policy', 'no-referrer'),
                   ('Cross-Origin-Resource-Policy', 'same-origin'),
                   ('Permissions-Policy', f'camera=(), microphone={microphone}, geolocation=()')]
        content_type = 'text/plain; charset=utf-8'
        status, data = '404 Not Found', b'Not found'
        origin = self.api.config.origin
        if (env.get('HTTP_HOST') != urlsplit(origin).netloc
                or env.get('HTTP_ORIGIN', origin) != origin
                or env.get('HTTP_SEC_FETCH_SITE', '') not in ('', 'same-origin', 'none')):
            status, data = '403 Forbidden', b'Same-origin request required'
        elif env.get('REQUEST_METHOD') not in ('GET', 'HEAD'):
            status, data = '405 Method Not Allowed', b'Use GET or HEAD'
            headers.append(('Allow', 'GET, HEAD'))
        elif not self._query_allowed(path, env.get('QUERY_STRING', '')):
            status, data = '400 Bad Request', b'Queries not supported'
        elif messenger_alias:
            status, data = '302 Found', b''
            headers.append(('Location', '/chat'))
            content_type = 'text/plain; charset=utf-8'
        else:
            directory, name, content_type = self.ASSETS[path]
            try:
                data = self._asset(directory, name)
                status = '200 OK'
            except OSError:
                status, data = '503 Service Unavailable', b'UI asset unavailable'
                content_type = 'text/plain; charset=utf-8'
            else:
                if name.endswith(('.css', '.js', '.mjs')):
                    cache_control = 'private, no-cache'
                    opaque_tag = f'"sha256-{sha256(data).hexdigest()}"'
                    # Proxies may encode these same package bytes with gzip or zstd.
                    headers.append(('ETag', 'W/' + opaque_tag))
                    if _matches_asset_etag(env.get('HTTP_IF_NONE_MATCH', ''), opaque_tag):
                        start_response('304 Not Modified', headers + [('Cache-Control', cache_control)])
                        return []
        headers += [('Cache-Control', cache_control), ('Content-Type', content_type),
                    ('Content-Length', str(len(data)))]
        start_response(status, headers)
        return [] if env.get('REQUEST_METHOD') == 'HEAD' else [data]
