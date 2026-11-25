import { mountImportedSkills } from './imports.mjs';
import { mountSkillExecution } from './execution.mjs';
import { csrfCookie } from '../home/runtime-readiness.mjs';
// Original content packages are loaded from the authenticated catalogue; no fake page-local installation.
// The binding lifecycle below decides what a runtime may load. The reader's own
// library membership ("我的技能库") is a separate per-account record: it never grants
// model context and never reaches a runtime on its own.

const INSTALLED = '/v1/skills/installed';

export function filterSkills(items = [], query = '') {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return items.slice();
  return items.filter((item) => `${item.name} ${item.description || item.content || ''}`.toLowerCase().includes(needle));
}

export function skillCountLabel(shown, total) {
  return shown === total ? `共 ${total} 个技能` : `显示 ${shown} / ${total} 个技能`;
}

export function accountButtonLabel(installed) {
  return installed ? '移出我的技能库' : '加入我的技能库';
}

async function errorText(response, fallback) {
  try {
    const payload = await response.json();
    const message = payload && payload.error && payload.error.message;
    if (typeof message === 'string' && message) return message;
  } catch (failure) {
    return fallback;
  }
  return fallback;
}

function installSet(payload) {
  return new Set(payload && Array.isArray(payload.installed) ? payload.installed : []);
}

export async function readInstalled(fetcher = fetch) {
  const response = await fetcher(INSTALLED, {
    method: 'GET',
    credentials: 'same-origin',
    headers: {Accept: 'application/json'},
  });
  if (!response.ok) throw new Error(await errorText(response, '读取已安装技能失败，请重试'));
  return installSet(await response.json());
}

export async function writeInstalled(skillId, wanted, options = {}) {
  const fetcher = options.fetchImpl || fetch;
  const cookie = options.cookie !== undefined
    ? options.cookie
    : (typeof document === 'undefined' ? '' : document.cookie);
  const response = await fetcher(INSTALLED, {
    method: wanted ? 'POST' : 'DELETE',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfCookie(cookie),
    },
    body: JSON.stringify({skill: skillId}),
  });
  if (!response.ok) {
    throw new Error(await errorText(response, wanted ? '安装失败，请重试' : '卸载失败，请重试'));
  }
  return installSet(await response.json());
}

export function mountSkills(document, {fetcher = globalThis.fetch.bind(globalThis), read, write, catalogue: given} = {}) {
  const list = document.getElementById('skills-list'), input = document.getElementById('skills-search');
  if (!list || !input) return null;
  const error = document.getElementById('skills-error');
  const scope = document.getElementById('skills-scope');
  const review = document.getElementById('skills-review');
  const reviewTitle = document.getElementById('skills-review-title');
  const reviewVersion = document.getElementById('skills-review-version');
  const reviewScope = document.getElementById('skills-review-scope');
  const reviewContent = document.getElementById('skills-review-content');
  const reviewDigest = document.getElementById('skills-review-digest');
  const reviewInstall = document.getElementById('skills-review-install');
  const reviewError = document.getElementById('skills-review-error');
  const confirmButton = document.getElementById('skills-review-confirm');
  const closeButton = document.getElementById('skills-review-close');
  const permission = document.getElementById('skills-permission');
  const cardControls = new Map();
  let catalogue = given || [], bindings = [], busy = false, pendingReview = null;
  const installedSet = new Set();
  const account = {
    read: read || (() => readInstalled(fetcher)),
    write: write || ((skillId, wanted) => writeInstalled(skillId, wanted, {fetchImpl: fetcher, cookie: document.cookie})),
  };
  async function request(method,path,body,key) {
    const csrf = csrfCookie(document.cookie);
    const result = await fetcher(path,{method, credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,...(key ? {'Idempotency-Key':key} : {})},body:body ? JSON.stringify(body) : undefined});
    const data = await result.json();
    if (!result.ok && result.status !== 200) throw new Error(data.error?.message || '请求失败。');
    return data;
  }
  const execution=mountSkillExecution(document,{request,scope});
  const imports=mountImportedSkills(document,{request,onChange:async()=>{
    const results=await Promise.all([request('GET','/v1/skills/catalog'),request('GET','/v1/skills/bindings')]);
    catalogue=results[0].items||[];bindings=results[1].items||[];render();await execution.refresh();
  }});
  function openReview(skill, selected, control, current) {
    if (busy || review.open) return;
    pendingReview = {skill, scope: selected, control};
    reviewTitle.textContent = skill.name;
    reviewVersion.textContent = '版本 ' + skill.version;
    reviewScope.textContent = scope?.selectedOptions?.[0]?.textContent || '我的账户';
    reviewContent.textContent = skill.content;
    reviewDigest.textContent = 'SHA-256 ' + skill.digest;
    reviewInstall.hidden = current;
    reviewError.textContent = '';
    permission.checked = false;
    confirmButton.disabled = true;
    review.showModal();
    reviewContent.scrollTop = 0;
  }

  async function updateBinding(skill, selected, enabled) {
    await request('POST', '/v1/skills/bindings', {
      skill_id: skill.id, version: skill.version, digest: skill.digest,
      scope: selected, enabled, permissions: ['model_context'],
    });
    bindings = (await request('GET', '/v1/skills/bindings')).items || [];
  }

  closeButton.addEventListener('click', () => review.close());
  review.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  review.addEventListener('close', () => {
    if (review.open || !pendingReview) return;
    const {skill, control} = pendingReview;
    pendingReview = null;
    permission.checked = false;
    (cardControls.get(skill.id)?.[control] || input).focus();
  });
  permission.addEventListener('change', () => { confirmButton.disabled = !permission.checked; });
  confirmButton.addEventListener('click', async () => {
    if (busy || !review.open || !pendingReview || !permission.checked || reviewInstall.hidden) return;
    const {skill, scope: selected} = pendingReview;
    busy = true;
    permission.disabled = true;
    confirmButton.disabled = true;
    closeButton.disabled = true;
    confirmButton.textContent = '正在安装…';
    reviewError.textContent = '';
    error.textContent = '';
    try {
      await updateBinding(skill, selected, true);
      error.textContent = '已安装到所选范围。';
    } catch (failure) {
      reviewError.textContent = failure.message || '网络错误，结果未知，请重试。';
    } finally {
      busy = false;
      permission.disabled = false;
      closeButton.disabled = false;
      confirmButton.disabled = !permission.checked;
      confirmButton.textContent = '确认安装';
    }
    if (reviewError.textContent) {
      confirmButton.focus();
      return;
    }
    render();
    review.close();
    await execution.refresh();
  });
  function render() {
    execution.setSkills(catalogue,bindings);
    const matches = filterSkills(catalogue,input.value);
    const selected = scope ? scope.value : 'account';
    list.replaceChildren();
    cardControls.clear();
    for (const skill of matches) {
      const item = document.createElement('li'); item.className='skill-card';
      if (installedSet.has(skill.id)) item.className+=' is-in-library';
      const mark = document.createElement('span'); mark.className='skill-mark';mark.textContent=skill.name.slice(0,1);
      const copy = document.createElement('span');copy.className='skill-copy';
      const name = document.createElement('strong');name.textContent=skill.name;
      const status = document.createElement('p');
      const binding = bindings.find(b => b.scope === selected && b.skill_id === skill.id);
      const current = Boolean(binding && binding.version === skill.version && binding.digest === skill.digest);
      if (binding) item.className += ' is-installed';
      status.textContent = binding && !current
        ? '版本已更新，请阅读新内容并重新安装'
        : current ? '已安装，可在所选范围内使用' : '未安装';
      const details = document.createElement('button');
      details.type = 'button';
      details.className = 'skill-details';
      details.textContent = '查看详情';
      details.setAttribute('aria-label', '查看详情 ' + skill.name);
      details.setAttribute('aria-haspopup', 'dialog');
      details.addEventListener('click', () => openReview(skill, selected, 'details', current));
      copy.append(name, status, details);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'skill-install';
      button.dataset.skill = skill.id;
      button.textContent = binding ? '卸载' : '安装';
      button.disabled = busy;
      button.setAttribute('aria-label', button.textContent + ' ' + skill.name);
      if (!binding) button.setAttribute('aria-haspopup', 'dialog');
      cardControls.set(skill.id, {details, binding: button});
      button.addEventListener('click', async () => {
        if (busy) return;
        if (!binding) {
          openReview(skill, selected, 'binding', false);
          return;
        }
        busy = true;
        button.disabled = true;
        error.textContent = '';
        try {
          await updateBinding(skill, selected, false);
          error.textContent = '已卸载。';
        } catch (failure) {
          error.textContent = failure.message || '网络错误，结果未知，请刷新检查。';
        } finally {
          busy = false;
          render();
          (cardControls.get(skill.id)?.binding || input).focus();
        }
      });
      const library = document.createElement('button');
      library.type='button';library.className='skill-library';library.dataset.library=skill.id;
      const inLibrary = installedSet.has(skill.id);
      library.textContent=accountButtonLabel(inLibrary);
      library.setAttribute('aria-pressed', inLibrary ? 'true' : 'false');
      library.setAttribute('aria-label', library.textContent + ' ' + skill.name);
      library.disabled=busy;
      library.addEventListener('click',async () => {
        if (busy) return;
        busy=true;library.disabled=true;error.textContent='';
        try {
          const next=await account.write(skill.id,!installedSet.has(skill.id));
          installedSet.clear();
          for (const value of next) installedSet.add(value);
        } catch(e) {error.textContent=e.message || '网络错误，结果未知，请刷新检查。';}
        finally {busy=false;render();}
      });
      if(skill.source==='user-imported'){
        const manage=document.createElement('button');manage.type='button';manage.textContent='管理版本';manage.addEventListener('click',()=>imports?.edit(skill));
        const revoke=document.createElement('button');revoke.type='button';revoke.textContent='撤销私有包';revoke.addEventListener('click',()=>imports?.revoke(skill));
        const download=document.createElement('a');download.textContent='下载 JSON 包';download.href='/v1/skills/packages/'+encodeURIComponent(skill.id)+'/versions/'+encodeURIComponent(skill.version);
        copy.append(manage,download,revoke);
      }
      item.append(mark,copy,button,library);
      if (binding) {
        const use = document.createElement('button');
        use.type = 'button';
        use.textContent = current ? '使用技能' : '重新安装当前版本';
        use.className = 'skill-use';
        use.disabled = busy;
        if (!current) use.setAttribute('aria-haspopup', 'dialog');
        cardControls.get(skill.id).use = use;
        use.addEventListener('click', () => {
          if (current) execution.selectSkill(skill.id);
          else openReview(skill, selected, 'use', false);
        });
        item.append(use);
      }
      list.append(item);
    }
    const empty=document.getElementById('skills-empty');if(empty)empty.hidden=matches.length>0;
    const count=document.getElementById('skills-count');if(count)count.textContent=skillCountLabel(matches.length,catalogue.length);
  }
  async function load() {
    try {
      const readLibrary = async () => {
        try { return await account.read(); }
        catch (e) { error.textContent = e.message || '读取我的技能库失败，请刷新重试。'; return []; }
      };
      const [catalogueResult, bindingResult, saved] = await Promise.all([
        request('GET','/v1/skills/catalog'), request('GET','/v1/skills/bindings'), readLibrary(),
      ]);
      const fetched = catalogueResult.items || [];
      catalogue = fetched.length ? fetched : (given || []);
      bindings = bindingResult.items || [];
      installedSet.clear();
      for (const value of saved) installedSet.add(value);
      render();
      if (!scope) return;
      const options=new Map();
      for(const binding of bindings){
        if(binding.scope==='account'||options.has(binding.scope))continue;
        const option=document.createElement('option');option.value=binding.scope;option.textContent='已绑定智能体（可撤销） · '+binding.scope.slice(-8);scope.append(option);options.set(binding.scope,option);
      }
      const scopes=(await request('GET','/v1/skills/scopes')).items || [];
      for (const entry of scopes) {
        if(entry.scope==='account')continue;
        const option=options.get(entry.scope)||document.createElement('option');option.value=entry.scope;
        option.textContent=(entry.kind==='automation'?'自动化 · ':'智能体 · ')+entry.label;
        if(!options.has(entry.scope)){scope.append(option);options.set(entry.scope,option);}
      }
      await execution.refresh();
    } catch(e) {error.textContent=e.message || '技能读取失败，请刷新重试。';}
  }
  input.addEventListener('input',render);
  if (scope) scope.addEventListener('change', () => { render(); execution.refresh(); });
  const ready=load();return {render,ready,installed:installedSet};
}

if (typeof document !== 'undefined') mountSkills(document);
