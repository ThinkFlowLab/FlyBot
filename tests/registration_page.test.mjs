import test from 'node:test';
import assert from 'node:assert/strict';
import {registerAccount, mountRegistration} from '../flybot_workspace/static/register/app.mjs';
import {takeSignupSession} from '../flybot_workspace/static/home/runtime-readiness.mjs';

const synthetic = 'synthetic fixture only';
test('registration posts JSON only to same-origin existing API', async () => {
  const result = await registerAccount('synthetic', synthetic, async (url, options) => {
    if(url==='/v1/auth/session'){assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');return {status:200,json:async()=>({user:{id:'fixture-id',username:'synthetic'}})};}
    assert.equal(url, '/v1/auth/register');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.mode, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), {username: 'synthetic', password: synthetic});
    return {status: 201};
  });
  assert.deepEqual(result, {ok: true});
});
test('failure text never echoes response/exception credentials', async () => {
  for (const fetcher of [
    async () => ({status: 403, json: async () => ({error: {code: 'registration_closed', message: synthetic}})}),
    async () => ({status: 500, json: async () => ({error: {code: synthetic, message: synthetic}})}),
    async () => { throw new Error(synthetic); },
  ]) {
    const result = await registerAccount('synthetic', synthetic, fetcher);
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(synthetic));
  }
});
function elements(valid = true) {
  const ids = ['register-form', 'register-submit', 'register-status', 'register-username', 'register-password'];
  const all = Object.fromEntries(ids.map(id => [id, {value: synthetic, textContent: '', dataset: {}, disabled: false, focus() {}}]));
  all['register-form'].reportValidity = () => valid;
  all['register-form'].addEventListener = (_, fn) => { all.submit = fn; };
  return {all, document: {getElementById: id => all[id]}};
}
test('successful form clears the password and opens private Chat directly', async () => {
  const {all, document} = elements();
  const user = {id: 'a'.repeat(32), username: synthetic};
  const personal_chat = {workspace_id: 'b'.repeat(32), agent_id: 'c'.repeat(32)};
  let destination;
  mountRegistration(document, path => { destination = path; }, async url => url === '/v1/auth/register'
    ? {status: 201, json: async () => ({user, personal_chat})}
    : {status: 200, json: async () => ({user})});
  await all.submit({preventDefault() {}});
  assert.equal(destination, `/chat#workspace=${personal_chat.workspace_id}&agent=${personal_chat.agent_id}`);
  assert.equal(all['register-password'].value, '');
  assert.equal(all['register-submit'].disabled, true);
});

test('unmanaged signup and invalid targets keep the Home fallback', async () => {
  for (const personal_chat of [undefined, {workspace_id: 'https://outside.invalid', agent_id: 'c'.repeat(32)}]) {
    const {all, document} = elements();
    const user = {id: 'a'.repeat(32), username: synthetic};
    let destination;
    mountRegistration(document, path => { destination = path; }, async url => url === '/v1/auth/register'
      ? {status: 201, json: async () => ({user, personal_chat})}
      : {status: 200, json: async () => ({user})});
    await all.submit({preventDefault() {}});
    assert.equal(destination, '/');
  }
});

test('signup with a valid invitation resumes the login continuation while retaining the expected account', async () => {
  const {all, document} = elements();
  const hash = '#team-invite=validSyntheticInvite';
  const values = new Map();
  document.defaultView = {
    location: {hash}, sessionStorage: {
      setItem: (key, value) => values.set(key, value),
      getItem: key => values.get(key),
      removeItem: key => values.delete(key),
    },
  };
  const id = 'a'.repeat(32);
  let destination;
  mountRegistration(document, path => { destination = path; }, async url => {
    assert.equal(url, '/v1/auth/register');
    return {status: 201, json: async () => ({user: {id, username: synthetic}})};
  });
  await all.submit({preventDefault() {}});
  assert.equal(destination, '/login' + hash);
  assert.equal(takeSignupSession(document.defaultView), id);
});
test('invalid forms do not send and failure does not navigate', async () => {
  for (const valid of [false, true]) {
    const {all, document} = elements(valid);
    let sends = 0;
    mountRegistration(document, () => assert.fail('failure navigated'), async () => {
      sends++; return {status: 403, json: async () => ({error: {code: 'registration_closed'}})};
    });
    await all.submit({preventDefault() {}});
    assert.equal(sends, valid ? 1 : 0);
    if (valid) assert.equal(all['register-password'].value, '');
  }
});

test('201 without actual session is not claimed as a successful login',async()=>{
 for(const response of [{status:401,json:async()=>({})},{status:200,json:async()=>({user:{id:'other',username:'other'}})}]){
  const result=await registerAccount('synthetic',synthetic,async url=>url==='/v1/auth/register'?{status:201}:response);
  assert.equal(result.ok,false);assert.equal(result.created,true);assert.ok(!JSON.stringify(result).includes(synthetic));
 }
});

test('registration hands off cookie confirmation without a duplicate session read when the tab can carry the account ID', async () => {
  const values = new Map();
  const view = {sessionStorage: {
    setItem: (key, value) => values.set(key, value), getItem: key => values.get(key), removeItem: key => values.delete(key),
  }};
  const id = 'a'.repeat(32);
  const result = await registerAccount('SYNTHETIC', synthetic, async url => {
    assert.equal(url, '/v1/auth/register');
    return {status: 201, json: async () => ({user: {id, username: 'synthetic'}})};
  }, view);
  assert.deepEqual(result, {ok: true, pendingSession: true});
  assert.doesNotMatch([...values.values()].join(''), /synthetic/);
  assert.equal(takeSignupSession(view), id);
  assert.equal(takeSignupSession(view), null);
});

test('denied tab storage or missing signup identity keeps the same-origin cookie confirmation', async () => {
  for (const [view, user] of [
    [{get sessionStorage() { throw new Error('storage denied'); }}, {id: 'a'.repeat(32), username: 'synthetic'}],
    [{sessionStorage: {setItem() { assert.fail('an invalid identity must not be carried'); }}}, {username: 'synthetic'}],
  ]) {
    const reads = [];
    const result = await registerAccount('synthetic', synthetic, async url => {
      reads.push(url);
      return url === '/v1/auth/register'
        ? {status: 201, json: async () => ({user})}
        : {status: 401, json: async () => ({})};
    }, view);
    assert.equal(result.created, true);
    assert.equal(result.ok, false);
    assert.deepEqual(reads, ['/v1/auth/register', '/v1/auth/session']);
  }
});

test('an ambiguous registration result resumes the confirmed personal Chat without another write', async () => {
  const id = 'a'.repeat(32);
  const personal_chat = {workspace_id: 'b'.repeat(32), agent_id: 'c'.repeat(32)};
  const personalChat = `/chat#workspace=${personal_chat.workspace_id}&agent=${personal_chat.agent_id}`;
  for (const lostResponse of [false, true]) {
    const values = new Map();
    const view = {sessionStorage: {
      setItem: (key, value) => values.set(key, value), getItem: key => values.get(key), removeItem: key => values.delete(key),
    }};
    const reads = [];
    const result = await registerAccount('  SYNTHETIC ', synthetic, async (url, options) => {
      reads.push([url, options.method]);
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.mode, 'same-origin');
      assert.equal(options.redirect, 'error');
      if (url === '/v1/auth/register') {
        if (lostResponse) throw new TypeError('lost registration response');
        return {status: 502};
      }
      assert.equal(options.body, undefined);
      if (url === '/v1/auth/session') return {status: 200, json: async () => ({user: {id, username: 'synthetic'}})};
      return {status: 200, json: async () => ({user_id: id, personal_chat})};
    }, view);
    assert.deepEqual(result, {ok: true, recovered: true, personalChat});
    assert.deepEqual(reads, [
      ['/v1/auth/register', 'POST'], ['/v1/auth/session', 'GET'], ['/v1/auth/runtime-readiness?include=personal-chat', 'GET'],
    ]);
    assert.equal(takeSignupSession(view), id);
  }
});

test('recovery requires matching session and personal runtime identity', async () => {
  const id = 'a'.repeat(32);
  for (const {session, owner, expectedReads} of [
    {session: {status: 401}, expectedReads: 2},
    {session: {status: 200, json: async () => ({user: {id, username: 'someone-else'}})}, expectedReads: 2},
    {session: {status: 200, json: async () => ({user: {id: 'non-platform-id', username: 'synthetic'}})}, expectedReads: 2},
    {session: {status: 200, json: async () => ({user: {id, username: 'synthetic'}})}, owner: 'd'.repeat(32), expectedReads: 3},
  ]) {
    const calls = [];
    const result = await registerAccount('synthetic', synthetic, async url => {
      calls.push(url);
      if (url === '/v1/auth/register') return {status: 502};
      if (url === '/v1/auth/session') return session;
      return {status: 200, json: async () => ({user_id: owner})};
    }, {sessionStorage: {setItem() { assert.fail('foreign or missing session carried'); }}});
    assert.equal(result.ok, false);
    assert.match(result.message, /登录/);
    assert.equal(calls.length, expectedReads);
  }
});

test('recovered signup continues a valid invitation and accurately confirms the session', async () => {
  const {all, document} = elements();
  const id = 'a'.repeat(32);
  const hash = '#team-invite=validSyntheticInvite';
  document.defaultView = {location: {hash}};
  let destination;
  mountRegistration(document, path => { destination = path; }, async url => {
    if (url === '/v1/auth/register') return {status: 502};
    if (url === '/v1/auth/session') return {status: 200, json: async () => ({user: {id, username: synthetic}})};
    return {status: 200, json: async () => ({user_id: id})};
  });
  await all.submit({preventDefault() {}});
  assert.equal(all['register-status'].textContent, '已确认登录，正在打开你访问的页面…');
  assert.equal(all['register-password'].value, '');
  assert.equal(destination, '/login' + hash);
});
