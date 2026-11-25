// Credentials stay in form memory and the existing same-origin auth API only.
import {publicAgentIntentFromHash, publicAgentContinuation} from '../shell/public-agent-link.mjs';
import {publicWorkIntentFromHash} from '../shell/public-work-link.mjs';
import {discoverIntentFromHash} from '../shell/discover-link.mjs';
import {teamInviteFromHash, teamInviteHash} from '../shell/team-invite-link.mjs';
import {groupInviteFromHash, groupInviteHash} from '../shell/group-invite-link.mjs';
import {rememberSignupSession, signupSessionError, workspaceLoginHash, workspaceLoginTarget} from '../home/runtime-readiness.mjs';
const MESSAGES = {
  registration_closed: '本实例尚未开放注册，请联系实例管理员。',
  conflict: '此用户名不可用，请选择其他用户名。',
  rate_limited: '尝试次数过多，请稍后再试。',
  invalid: '请检查用户名和密码格式。',
  quota: '本实例账户数量已达上限。',
};

const platformId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const uncertainSignupMessage = '暂时无法确认注册结果。如果账户已创建，请尝试登录。';
const authReadOptions = {
  method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
  headers: {Accept: 'application/json'},
};

function personalChatPath(target) {
  const {workspace_id: workspace, agent_id: agent} = target || {};
  return platformId(workspace) && platformId(agent) ? '/chat#workspace=' + workspace + '&agent=' + agent : '';
}

async function readSignupUser(fetcher, expectedName, expectedId) {
  try {
    const session = await fetcher('/v1/auth/session', authReadOptions);
    if (session.status !== 200) return null;
    const {user} = await session.json();
    if (user?.id && user.username === expectedName && (!expectedId || user.id === expectedId)) return user;
  } catch {}
  return null;
}

async function recoverSignup(fetcher, view, expectedName) {
  const user = await readSignupUser(fetcher, expectedName);
  if (!platformId(user?.id)) return {ok: false, message: uncertainSignupMessage};
  let personalChat = '';
  try {
    const readiness = await fetcher('/v1/auth/runtime-readiness?include=personal-chat', authReadOptions);
    if (readiness.status === 200) {
      const {user_id: owner, personal_chat: target} = await readiness.json();
      if (owner !== user.id) return {ok: false, message: uncertainSignupMessage};
      personalChat = personalChatPath(target);
    } else if (readiness.status === 401 || readiness.status === 403) {
      return {ok: false, message: uncertainSignupMessage};
    }
  } catch {}
  rememberSignupSession(view, user.id, undefined, personalChat);
  return {ok: true, recovered: true, ...(personalChat && {personalChat})};
}

export async function registerAccount(username, password, fetcher = globalThis.fetch, view) {
  const expectedName = username.trim().toLowerCase();
  let response;
  try {
    response = await fetcher('/v1/auth/register', {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
      headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
      body: JSON.stringify({username, password}),
    });
  } catch {
    return recoverSignup(fetcher, view, expectedName);
  }
  if (response.status >= 500) return recoverSignup(fetcher, view, expectedName);
  if (response.status === 201) {
    let personalChat = '', expectedId;
    // Let the destination's existing session read confirm the account when the
    // browser can pass a short-lived ID to the next same-tab document.
    try {
      const {user, personal_chat: target} = await response.json();
      if (user?.username === expectedName && platformId(user.id)) {
        expectedId = user.id;
        personalChat = personalChatPath(target);
        if (rememberSignupSession(view, expectedId, undefined, personalChat)) {
          return {ok: true, pendingSession: true, ...(personalChat && {personalChat})};
        }
      }
    } catch {}
    if (await readSignupUser(fetcher, expectedName, expectedId)) {
      return {ok: true, ...(personalChat && {personalChat})};
    }
    return {ok: false, created: true, message: signupSessionError};
  }
  const body = await response.json().catch(() => ({}));
  // Never render arbitrary backend bodies or exceptions (which may echo input).
  const code = body?.error?.code;
  return {ok: false, message: Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : '未能创建账户，请稍后重试。'};
}

export function mountRegistration(document, navigate, fetcher = globalThis.fetch) {
  const form = document.getElementById('register-form');
  const button = document.getElementById('register-submit');
  const status = document.getElementById('register-status');
  const username = document.getElementById('register-username');
  const password = document.getElementById('register-password');
  const hash = document.defaultView?.location?.hash;
  const work = publicWorkIntentFromHash(hash);
  const continuation = workspaceLoginHash(workspaceLoginTarget(hash)) ||
    teamInviteHash(teamInviteFromHash(hash)) || groupInviteHash(groupInviteFromHash(hash)) ||
    work?.continuation || publicAgentContinuation(publicAgentIntentFromHash(hash)) || discoverIntentFromHash(hash)?.continuation;
  const login = document.querySelector?.('a[href="/login"]');
  if (login && continuation) login.href = '/login' + continuation;
  let attempted=false;
  const policy=document.getElementById('register-policy');
  if(policy)Promise.resolve(fetcher('/v1/auth/policy',{method:'GET',credentials:'same-origin',mode:'same-origin',redirect:'error'})).then(async response=>{
    const data=await response.json();
    if(attempted)return;
    if(response.status!==200||typeof data.registration_open!=='boolean')throw new Error('policy');
    policy.dataset.kind = data.registration_open ? '' : 'error';
    policy.textContent = !data.registration_open ? '尚未开放注册，请联系管理员。'
      : continuation ? '注册后将打开你访问的页面。' : '已开放注册。';
  }).catch(()=>{
    if (attempted) return;
    policy.dataset.kind = 'error';
    policy.textContent = '暂时无法读取注册状态。';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled || !form.reportValidity()) return;
    attempted=true;
    button.disabled = true;
    status.dataset.kind = '';
    status.textContent = '正在创建账户…';
    const result = await registerAccount(username.value, password.value, fetcher, document.defaultView);
    password.value = '';
    button.disabled = result.ok || result.created === true;
    if (result.ok) {
      const confirmation = result.recovered ? '已确认登录' : '账户已创建';
      status.textContent = continuation ? confirmation + '，正在打开你访问的页面…'
        : result.personalChat ? confirmation + '，正在打开私人聊天…' : confirmation + '，正在打开个人工作区…';
      navigate(continuation ? '/login' + continuation : result.personalChat || '/');
    } else {
      status.dataset.kind = 'error';
      status.textContent = result.message;
      password.focus();
    }
  });
}

if (typeof document !== 'undefined') {
  mountRegistration(document, path => globalThis.location.assign(path));
}
