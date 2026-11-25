import assert from 'node:assert/strict';
import test from 'node:test';
import { envelope, install, movedTarget, servedByDsBot, toResponse } from '../flybot_workspace/static/shell/dsbot-api.mjs';

const ORIGIN = 'https://flybot-workspace.example';
const WS = 'a'.repeat(32);
const ID = 'b'.repeat(32);

test('call recording consent uses the owner runtime on both call roots', () => {
  for (const path of ['/v1/meeting-calls/recording', `/v1/workspaces/${WS}/social/conversations/otc_call/call/recording`]) {
    assert.deepEqual(movedTarget(path, ORIGIN), {feature:'messenger', path});
  }
});

test('workspace export routes only its canonical path and keeps paging in the owner runtime', () => {
  const path = `/v1/workspaces/${WS}/export`;
  const paged = path + '?type=memory&cursor=20';
  const target = {feature:'export', path:paged};
  assert.deepEqual(movedTarget(paged, ORIGIN),target);
  assert.deepEqual(envelope(target, 'GET'),{endpoint:'export/v1', payload:{method:'GET',path:paged}});
  assert.equal(movedTarget(path + '/another', ORIGIN), null);
  assert.equal(movedTarget('/v1/workspaces/other/export', ORIGIN), null);
  assert.equal(movedTarget('https://other.example' + path, ORIGIN), null);
});

test('copying shared work goes only to the signed owner artifact runtime', () => {
  for (const action of ['shared-copy','studio-personal-copy']) {
    const path = `/v1/workspaces/${WS}/artifacts/${action}`;
    assert.deepEqual(movedTarget(path,ORIGIN),{feature:'artifacts',path});
    assert.equal(movedTarget(path + '/extra',ORIGIN),null);
  }
});

test('the personal sticker library routes only canonical paths to the owner runtime', () => {
  for (const path of ['/v1/stickers?limit=20', `/v1/stickers/${ID}`, `/v1/stickers/${ID}/file`]) {
    assert.deepEqual(movedTarget(path, ORIGIN), {feature:'stickers', path});
  }
  assert.equal(movedTarget('/v1/stickers/other/file', ORIGIN), null);
});

test('moved meeting routes go to the meetings feature of the user\'s own DS-Bot', () => {
  assert.deepEqual(movedTarget(`/v1/workspaces/${WS}/meetings?limit=20`, ORIGIN),
    { feature: 'meetings', path: `/v1/workspaces/${WS}/meetings?limit=20` });
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/${ID}/export`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/${ID}/artifact`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/${ID}/memory`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/${ID}/action?index=0&revision=1`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/memory/actions/from-meeting`, ORIGIN).feature, 'memory');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/draft`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/speech`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/share-recipients?conversation_id=otc_1`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/${ID}/shares`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/shared`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/shared/${ID}/revoke`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/shared/${ID}/discussion`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/transcribe`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/from-call/otcav_${'A'.repeat(26)}`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/from-call/otcav_${'O'.repeat(26)}`, ORIGIN), null);
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/${ID}/draft`, ORIGIN), null);
  assert.equal(movedTarget(`/v1/workspaces/${WS}/memory?q=x`, ORIGIN).feature, 'memory');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/memory/${ID}/versions/3/restore`, ORIGIN).feature, 'memory');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/memory/${ID}/dream/${ID}`, ORIGIN).feature, 'memory');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/memory/${ID}/share-group`, ORIGIN).feature, 'memory');
  for (const rest of ['actions', `actions/${ID}/remove`, 'links', 'graph', 'profile', 'profile/dream', 'candidates', `candidates/${ID}`, `preferences/${ID}/remove`]) {
    assert.equal(movedTarget(`/v1/workspaces/${WS}/memory/${rest}`, ORIGIN).feature, 'memory', rest);
  }
  assert.equal(movedTarget(`/v1/workspaces/${WS}/memory/bogus`, ORIGIN), null);
  assert.equal(movedTarget(`/v1/workspaces/${WS}/search/messages?q=x`, ORIGIN).feature, 'search');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/search/resources?kind=links`, ORIGIN).feature, 'search');
  assert.equal(movedTarget('/v1/auth/session', ORIGIN), null);
  assert.equal(movedTarget('/v1/automation-templates', ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/automations`, ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/automations/tick`, ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/automations/draft`, ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/automations/schedule-preview`, ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/automations/${ID}`, ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/automations/${ID}/run`, ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/automations/${ID}/runs/${ID}/retry`, ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents?limit=100`, ORIGIN).feature, 'agents');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/conversations/${ID}/memory/capture`, ORIGIN).feature, 'agents');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/archive`, ORIGIN).feature, 'agents');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/conversations/${ID}/messages`, ORIGIN).feature, 'agents');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/conversations/${ID}/attachments?kind=file`, ORIGIN).feature, 'agents');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/conversations/${ID}/messages/${ID}/retry`, ORIGIN).feature, 'agents');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/conversations/${ID}/reply-progress?key=reply-test-key-123`, ORIGIN).feature, 'agents');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/conversations/${ID}/reply-stop`, ORIGIN).feature, 'agents');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/api-keys`, ORIGIN).feature, 'agent-api');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/api-keys/${ID}/revoke`, ORIGIN).feature, 'agent-api');
  // Cross-user / provision routes stay on the platform.
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/homepage`, ORIGIN), null);
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/runtime`, ORIGIN), null);
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/discover`, ORIGIN).feature, 'discover');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/discover/revoke`, ORIGIN).feature, 'discover');
  assert.equal(movedTarget('/v1/settings', ORIGIN).feature, 'settings');
  assert.equal(movedTarget('/v1/notification-prefs', ORIGIN).feature, 'settings');
  assert.equal(movedTarget('/v1/onboarding/look', ORIGIN).feature, 'settings');
  assert.equal(movedTarget('/v1/onboarding/progress', ORIGIN).feature, 'settings');
  assert.equal(movedTarget('/v1/onboarding/recommendations', ORIGIN).feature, 'settings');
  assert.equal(movedTarget('/v1/model-api', ORIGIN).feature, 'model-api');
  assert.equal(movedTarget('/v1/model-api/image', ORIGIN).feature, 'model-api');
  assert.equal(movedTarget('/v1/model-api/video', ORIGIN).feature, 'model-api');
  assert.equal(movedTarget('/v1/model-api/music', ORIGIN).feature, 'model-api');
  assert.equal(movedTarget('/v1/model-api/model3d', ORIGIN).feature, 'model-api');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/images`, ORIGIN).feature, 'images');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/videos`, ORIGIN).feature, 'videos');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/music`, ORIGIN).feature, 'music');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/models-3d`, ORIGIN).feature, 'model3d');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/images/${ID}`, ORIGIN).feature, 'images');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/videos/${ID}`, ORIGIN).feature, 'videos');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/music/${ID}`, ORIGIN).feature, 'music');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/websites`, ORIGIN).feature, 'websites');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/websites/${ID}`, ORIGIN).feature, 'websites');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/models-3d/${ID}`, ORIGIN).feature, 'model3d');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/images/wrong`, ORIGIN), null);
  assert.equal(movedTarget(`/v1/composio/connections/${ID}/disconnect`, ORIGIN).feature, 'connectors');
  assert.equal(movedTarget(`/v1/mcp/servers/${ID}`, ORIGIN).feature, 'connectors');
  assert.equal(movedTarget('/v1/composio/callback', ORIGIN), null);
  assert.equal(movedTarget('/v1/skill-secrets', ORIGIN).feature, 'skill-secrets');
  assert.equal(movedTarget('/v1/onboarding/automations', ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`https://evil.example/v1/workspaces/${WS}/meetings`, ORIGIN), null);
});


test('members, team, messenger and discover /v1 routes go to the C features', () => {
  assert.deepEqual(movedTarget('/v1/profile/social?view=following', ORIGIN), {
    feature: 'discover', path: '/v1/profile/social?view=following',
  });
  assert.equal(movedTarget('/v1/profile', ORIGIN), null);
  assert.equal(movedTarget('/v1/profile/avatar', ORIGIN), null);
  assert.equal(movedTarget(`/v1/workspaces/${WS}/members`, ORIGIN).feature, 'members');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/members/${ID}/remove`, ORIGIN).feature, 'members');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/members/ann.home/suspend`, ORIGIN).feature, 'members');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/members/ann.home/transfer-ownership`, ORIGIN).feature, 'members');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/invites`, ORIGIN).feature, 'invites');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/invites/oti_01/revoke`, ORIGIN).feature, 'invites');
  assert.equal(movedTarget('/v1/invites/accept', ORIGIN).feature, 'invites');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/join-requests/${ID}/approve`, ORIGIN).feature, 'invites');
  assert.equal(movedTarget('/v1/join-requests', ORIGIN).feature, 'invites');
  assert.equal(movedTarget('/v1/team-directory?q=guild', ORIGIN).feature, 'teams');
  assert.equal(movedTarget(`/v1/team-directory/${WS}/join`, ORIGIN).feature, 'teams');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/directory`, ORIGIN).feature, 'teams');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/social/conversations?limit=20`, ORIGIN).feature, 'messenger');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/social/conversations/otc_01/messages`, ORIGIN).feature, 'messenger');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/social/conversations/otc_01/attachments?kind=photo`, ORIGIN).feature, 'messenger');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/social/conversations/otc_01/memory/capture`, ORIGIN).feature, 'messenger');
  for (const action of ['create', 'preview', 'join', 'poll', 'signal', 'leave', 'end']) {
    assert.equal(movedTarget('/v1/meeting-calls/' + action, ORIGIN).feature, 'messenger');
  }
  assert.equal(movedTarget('/v1/discover/agents?q=x', ORIGIN).feature, 'discover');
  assert.equal(movedTarget('/v1/discover/me/works?tab=following', ORIGIN).feature, 'discover');
  assert.equal(movedTarget('/v1/discover/works/my-essay/engagement', ORIGIN).feature, 'discover');
  // Workspace lists and team creation use the DS-Bot teams feature.
  assert.equal(movedTarget('/v1/auth/session', ORIGIN), null);
  assert.equal(movedTarget('/v1/workspaces?limit=100', ORIGIN).feature, 'teams');
  assert.equal(movedTarget(`/v1/workspaces/${WS}`, ORIGIN), null);
  assert.equal(movedTarget('/v1/teams', ORIGIN).feature, 'teams');
});

test('the envelope carries method, path, body and idempotency key only', () => {
  const env = envelope({ feature: 'meetings', path: '/v1/x' }, 'post', { 'Idempotency-Key': 'k'.repeat(20), 'X-CSRF-Token': 't' }, '{"title":"周会"}');
  assert.deepEqual(env, { endpoint: 'meetings/v1', payload: { method: 'POST', path: '/v1/x', idempotency_key: 'k'.repeat(20), body: { title: '周会' } } });
});

test('Space activity stays in the owner artifact feature and does not reuse management streaming', () => {
  const activity = `/v1/workspaces/${WS}/artifacts/activity?artifact=${ID}`;
  assert.deepEqual(movedTarget(activity, ORIGIN), {feature: 'artifacts', path: activity});
  assert.equal(movedTarget(`/v1/workspaces/${WS}/events`, ORIGIN), null);
});

test('team studio is dispatched to the account runtime with its revision query', () => {
  const path = `/v1/workspaces/${WS}/studio/documents/${ID}?revision=3`;
  assert.deepEqual(movedTarget(path, ORIGIN), {feature:'studio',path});
  const revision = `/v1/workspaces/${WS}/studio/documents/${ID}/versions/3`;
  assert.deepEqual(movedTarget(revision, ORIGIN), {feature:'studio',path:revision});
});

test('answers become ordinary responses, downloads keep their name', async () => {
  const json = toResponse({ status: 409, body: { error: { code: 'conflict' } } });
  assert.equal(json.status, 409);
  assert.equal((await json.json()).error.code, 'conflict');
  const file = toResponse({ status: 200, download: { content_type: 'text/markdown', filename: 'm.md', data: Buffer.from('# hi').toString('base64') } });
  assert.equal(await file.text(), '# hi');
  assert.match(file.headers.get('Content-Disposition'), /m\.md/);
});

test('binary shim downloads preserve Chinese and emoji names in an ASCII-compatible header', async () => {
  const filename = '陶瓷花瓶 🏺.glb';
  const file = toResponse({status: 200, download: {
    content_type: 'model/gltf-binary', filename, data: 'Z2xURg==', inline: true,
  }});
  assert.equal(await file.text(), 'glTF');
  const header = file.headers.get('Content-Disposition');
  assert.match(header, /^inline; filename="[ -~]+";/);
  assert.equal(decodeURIComponent(header.split("filename*=UTF-8''")[1]), filename);
});

test('does nothing on pages served by the legacy platform', () => {
  const doc = { querySelector: () => null, addEventListener() { throw new Error('must not install'); } };
  assert.equal(servedByDsBot(doc), false);
  assert.equal(install({ document: doc, location: { origin: ORIGIN }, fetch() { throw new Error('no'); } }), null);
});

test('moved artifact routes go to the artifacts feature of the user\'s own DS-Bot', () => {
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts?limit=20`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/${ID}`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/${ID}/file`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/${ID}/export`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/spreadsheet/draft`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/slides/draft`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/document/draft`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/${ID}/versions/3/export`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/${ID}/shares/${ID}/revoke`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/${ID}/shares/${ID}/link`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/${ID}/shares/${ID}/link/extra`, ORIGIN), null);
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/${ID}/favorite`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/bogus`, ORIGIN), null);
});

test('a missing moved feature never falls back to platform execution', async () => {
  const calls = [];
  const win = {
    document: {querySelector: () => ({}), addEventListener() {}},
    location: {origin: ORIGIN},
    async fetch(url) {
      calls.push(url);
      return Response.json({ok: false, error: {code: 'flybot-workspace/not-found'}});
    },
  };
  install(win);
  const response = await win.fetch('/v1/settings');
  assert.equal(response.status, 502);
  assert.deepEqual(calls, ['/b/api/flybot-workspace']);
});

test('moved notification read requests retain keepalive on the actual DS-Bot fetch', async () => {
  const calls = [];
  const win = {
    document: {querySelector: () => ({}), addEventListener() {}},
    location: {origin: ORIGIN},
    async fetch(url, options) {
      calls.push({url, options});
      return Response.json({ok: true, value: {status: 200, body: {unread_count: 0}}});
    },
  };
  install(win);
  const path = `/v1/workspaces/${WS}/notifications/read`;
  const post = {method: 'POST', body: JSON.stringify({notification_id: ID})};
  await win.fetch(path, {...post, keepalive: true});
  await win.fetch(new Request(ORIGIN + path, {...post, keepalive: true}));
  await win.fetch(path, post);
  assert.deepEqual(calls.map(call => call.url), Array(3).fill('/b/api/flybot-workspace'));
  assert.deepEqual(calls.map(call => call.options.keepalive), [true, true, undefined]);
  assert.deepEqual(JSON.parse(calls[0].options.body), {endpoint: 'social/v1', payload: {
    method: 'POST', path, body: {notification_id: ID},
  }});
});

test('work detail, remix and comment paths stay within the viewer’s Discover plugin', () => {
  const base = '/v1/discover/works/work-demo';
  const id = 'otwc_' + '0'.repeat(26);
  for (const path of [base, base + '/remix', base + '/comments?limit=20', base + '/comments/' + id + '/like', base + '/comments/' + id + '/remove']) {
    assert.equal(movedTarget(path, ORIGIN)?.feature, 'discover');
  }
  assert.equal(movedTarget(base + '/comments/forum/comment', ORIGIN), null);
});
test('collaboration pages use the owner runtime for private runs and Bot Social shares', () => {
  const origin = 'https://flybot-workspace.example';
  const base = '/v1/workspaces/' + 'c'.repeat(32);
  const run = base + '/team-runs/' + 'd'.repeat(32);
  const share = base + '/shared-runs/otsr_' + '1'.repeat(26);
  for (const [path, feature] of [
    [base + '/team-runs', 'team-runs'], [run + '/steps/0/artifact', 'team-runs'],
    [run + '/export', 'team-runs'],
    [run + '/steps/7/retry', 'team-runs'], [run + '/share', 'shares'], [share + '/revoke', 'shares'],
  ]) {
    assert.deepEqual(movedTarget(path, origin), {feature, path});
  }
  assert.equal(movedTarget(run + '/steps/8/retry', origin), null);
});

test('memory pin writes route to the owner plugin only for exact workspace and page ids', () => {
  const path = `/v1/workspaces/${WS}/memory/${ID}/pin`;
  assert.deepEqual(movedTarget(path, ORIGIN), {feature:'memory',path});
  assert.equal(movedTarget(path + '/other', ORIGIN), null);
  assert.equal(movedTarget(path.replace(ID, 'unrelated'), ORIGIN), null);
});
