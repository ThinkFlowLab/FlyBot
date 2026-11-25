// Original persisted skill execution UI. Provider calls happen only in the authenticated runtime.
export const readinessLabels = {
  ready:'你的 DS-Bot 已就绪，可以试用已安装的技能。',
  no_model:'当前范围尚未配置可用模型，请检查模型设置。',
  runtime_offline:'你的 DS-Bot 暂未就绪，请稍后刷新。',
  runtime_upgrade_required:'当前 DS-Bot 版本不支持此技能，请联系管理员更新。',
  model_missing:'当前范围尚未配置可用模型。请先保存模型配置；不会伪造结果。',
  provider_unsupported:'当前模型不是此运行时支持的 OpenAI-compatible 接口。请调整配置。',
  delegated_runtime:'该智能体绑定了别人的运行时，个人技能不能传给它。请由管理员调整绑定或选择自己的范围。',
  scope_forbidden:'当前范围已失去权限或被归档；可以撤销旧绑定，不能创建新任务。',
};

export function mountSkillExecution(document,{request,scope,keyFactory=()=>globalThis.crypto.randomUUID().replaceAll('-','')}={}) {
  const get=id=>document.getElementById(id), form=get('skill-run-form'), selector=get('skill-run-skill');
  let catalogue=[],bindings=[],ready=false,busy=false,attempt=null,epoch=0,history=[];
  function setSkills(items,installed){
    catalogue=items;bindings=installed;const previous=selector.value;selector.replaceChildren();
    const eligible=[];
    for(const binding of installed.filter(b=>b.scope===scope.value)){
      const skill=items.find(i=>i.id===binding.skill_id&&i.digest===binding.digest&&i.version===binding.version);
      if(!skill)continue;eligible.push(skill);
      const option=document.createElement('option');option.value=skill.id;option.textContent=skill.name;selector.append(option);
    }
    selector.value=eligible.some(s=>s.id===previous)?previous:(eligible[0]?.id||'');
    get('skill-run-submit').disabled=busy||!ready||!eligible.length;
  }
  function showError(error){get('skill-run-error').textContent=error?.message||'请求失败，结果未知，请刷新记录后重试。'}
  function renderHistory(){
    const list=get('skill-run-history');list.replaceChildren();
    const records=history.filter(r=>r.scope===scope.value);
    if(!records.length){const empty=document.createElement('li');empty.textContent='此范围暂无运行记录。安装不会自动运行。';list.append(empty);}
    for(const record of records){
      const task=record.task,li=document.createElement('li'),title=document.createElement('strong');
      title.textContent=(record.skill_id==='*'?'自动化技能组合':(catalogue.find(i=>i.id===record.skill_id)?.name||record.skill_id))+' · '+task.status;
      const proof = document.createElement('p');
      proof.textContent = record.verified ? '已确认所选技能可用，任务已返回结果。'
        : record.loaded ? '已确认所选技能可用。' : '正在等待技能状态。';
      const output=document.createElement('pre');output.textContent=task.result?.text||task.result?.error||task.prompt;
      li.append(title,proof,output);
      const identity = document.createElement('small');
      const skills = (record.skills || []).map(skill => skill.version ? skill.id + '@' + skill.version : skill.id);
      identity.textContent = ['任务 ' + task.id, new Date(task.created * 1000).toLocaleString(), ...skills].join(' · ');
      li.append(identity);
      if(['queued','claimed'].includes(task.status)){
        const cancel=document.createElement('button');cancel.type='button';cancel.textContent='取消此任务';
        cancel.addEventListener('click',async()=>{cancel.disabled=true;try{await request('POST','/v1/skills/runs/'+task.id+'/cancel',{});await refresh()}catch(e){showError(e)}finally{cancel.disabled=false}});li.append(cancel);
      }
      if(record.verified){
        const save=document.createElement('button');save.type='button';save.textContent='保存结果为工作区文档';
        save.addEventListener('click',async()=>{save.disabled=true;try{
          const workspace=get('skill-result-workspace').value;
          if(!workspace)throw new Error('请先选择可访问的工作区；保存后成员可见。');
          const data=await request('POST','/v1/skills/runs/'+task.id+'/artifact',{workspace_id:workspace});
          const link=document.createElement('a');link.href='/space?workspace='+workspace+'&artifact='+data.artifact.id;link.textContent='打开已保存文档';li.append(link);
        }catch(e){showError(e)}finally{save.disabled=false}});li.append(save);
      }
      list.append(li);
    }
  }
  async function refresh(){
    const current=++epoch,selected=scope.value;ready=false;setSkills(catalogue,bindings);get('skills-readiness').textContent='正在检查当前范围…';
    try{
      const [state,runs]=await Promise.all([request('GET','/v1/skills/readiness?scope='+encodeURIComponent(selected)),request('GET','/v1/skills/runs')]);
      if(current!==epoch||selected!==scope.value)return;
      ready=state.ready===true;history=runs.items||[];
      get('skills-readiness').textContent=readinessLabels[state.code]||'状态未知，不能当作已准备好。';
      setSkills(catalogue,bindings);renderHistory();
    }catch(e){if(current===epoch){ready=false;get('skills-readiness').textContent='状态检查失败，未确认运行时可用。';showError(e);setSkills(catalogue,bindings)}}
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;
    const body={scope:scope.value,skill_id:selector.value,prompt:get('skill-run-prompt').value},serialized=JSON.stringify(body);
    if(!attempt||attempt.serialized!==serialized)attempt={serialized,key:keyFactory()};
    busy=true;get('skill-run-error').textContent='';setSkills(catalogue,bindings);
    try{await request('POST','/v1/skills/runs',body,attempt.key);attempt=null;await refresh()}
    catch(e){showError(e)}finally{busy=false;setSkills(catalogue,bindings)}
  });
  get('skills-refresh').addEventListener('click',refresh);
  const workspacesReady=request('GET','/v1/workspaces').then(data=>{
    const workspace=get('skill-result-workspace');
    for(const item of data.items||[]){const option=document.createElement('option');option.value=item.id;option.textContent=item.name;workspace.append(option)}
  }).catch(showError);
  const timer=document.defaultView?.setInterval?.(()=>{if(!document.hidden&&history.some(r=>['queued','claimed'].includes(r.task.status)))refresh()},3000);
  return {setSkills,refresh,workspacesReady,selectSkill(id){selector.value=id;get('skill-run-prompt').focus?.();form.scrollIntoView?.({block:'center',behavior:'auto'})},dispose(){epoch++;if(timer)document.defaultView.clearInterval(timer)}};
}
