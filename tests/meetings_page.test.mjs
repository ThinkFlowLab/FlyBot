import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeMeetingFields, mountMeetingShares, parseAttendees, renderSharedMeeting } from '../flybot_workspace/static/meetings/app.mjs';
import { discussionContext, mountMeetingDiscussion } from '../flybot_workspace/static/meetings/discussion.mjs';
import { mountTranscriptSearch } from '../flybot_workspace/static/meetings/transcript-search.mjs';
import { readTranscriptFile } from '../flybot_workspace/static/meetings/transcript-import.mjs';
import { mountMeetingAudio } from '../flybot_workspace/static/meetings/audio.mjs';
import { mountMeetingPrint } from '../flybot_workspace/static/meetings/print.mjs';

test('meeting transcript imports preserve literal text and normalize caption cues', async () => {
  const text = new File(['\uFEFF# Meeting\r\n<a> quoted verbatim'], 'notes.md');
  assert.equal(await readTranscriptFile(text), '# Meeting\n<a> quoted verbatim');
  const vtt = new File(['WEBVTT\n\nNOTE dropped\n\nintro\n00:01.000 --> 00:03.000 align:start\n<v Mei><i>Hello</i> &amp; bye.'], 'notes.VTT');
  assert.equal(await readTranscriptFile(vtt), 'Mei：Hello & bye.');
  const srt = new File(['1\r\n00:00:01,000 --> 00:00:04,000\r\nFirst line\r\n<i>Second line</i>\r\n\r\n2\r\n00:00:05,000 --> 00:00:07,000\r\nLast line'], 'notes.srt');
  assert.equal(await readTranscriptFile(srt), 'First line\nSecond line\nLast line');
});

test('meeting transcript imports reject unsupported, malformed and oversized files', async () => {
  await assert.rejects(readTranscriptFile(new File(['text'], 'notes.html')), /请选择 TXT/);
  await assert.rejects(readTranscriptFile(new File(['WEBVTT\n\nNOTE discarded'], 'empty.vtt')), /没有读到字幕正文/);
  await assert.rejects(readTranscriptFile(new File([Uint8Array.of(0xc0, 0xaf)], 'binary.txt')), /UTF-8/);
  await assert.rejects(readTranscriptFile(new File(['transcript'], 'notes.txt'), 5), /超过 5 字/);
  await assert.rejects(readTranscriptFile(new File(['a'.repeat(512 * 1024 + 1)], 'large.txt')), /超过 512 KB/);
});

test('meeting version review merges disjoint edits and flags overlapping fields', () => {
  const actions = [['核对报告', 'Alice', false, '2026-12-01']];
  const base = ['会议', '2026-11-22T13:00', 'Alice', '摘要', '旧正文', actions];
  const local = ['后续会议', base[1], base[2], '我的摘要', base[4], actions];
  const remote = [base[0], base[1], base[2], '后提交的摘要', '新正文', [['核对报告', 'Alice', true, '2026-12-01']]];
  assert.deepEqual(mergeMeetingFields(base, local, remote), {
    fields:['后续会议', base[1], base[2], '我的摘要', '新正文', remote[5]], conflicts:[3],
  });
  assert.deepEqual(mergeMeetingFields(base, remote, remote), {fields:remote, conflicts:[]});
});

test('meeting discussion includes only saved summary and open actions until the transcript is selected', () => {
  const meeting = {title:'Review', revision:3, summary:'Saved notes', transcript:'Private transcript', attendees:['Private attendee'],
    action_items:[{text:'Check proof', owner:'Rae', due_date:'2026-11-25', done:false}, {text:'Closed task', done:true}]};
  const {text,clipped} = discussionContext(meeting);
  assert.match(text,/Review.*3/);
  assert.match(text,/Saved notes/);
  assert.match(text,/Check proof.*Rae.*2026-11-25/);
  assert.doesNotMatch(text,/Private transcript|Private attendee|Closed task/);
  assert.equal(clipped,false);
  assert.match(discussionContext(meeting,true).text,/Private transcript/);
  assert.doesNotMatch(discussionContext({...meeting,shared:true},true).text,/Private transcript/);
  const transcriptOnly = {...meeting,summary:'',action_items:[]};
  assert.equal(discussionContext(transcriptOnly).text,'');
  assert.match(discussionContext(transcriptOnly,true).text,/Private transcript/);
});

test('meeting discussion preview leaves enough room for the editable question', () => {
  const large = '😀'.repeat(4000);
  const meeting = {title:'Review',revision:7,summary:large,transcript:large,action_items:[{text:large}]};
  const {text,clipped} = discussionContext(meeting,true);
  assert.equal(clipped,true);
  assert.ok(text.length + 1002 <= 4000);
  assert.match(text,/摘要\n[\s\S]+未完成的行动项\n[\s\S]+转写 \/ 正文/);
  assert.equal(text.isWellFormed(),true);
});

test('parseAttendees trims, dedupes and splits both comma forms', () => {
  assert.deepEqual(parseAttendees('alice, bob，alice'), ['alice', 'bob']);
  assert.deepEqual(parseAttendees(''), []);
  assert.deepEqual(parseAttendees('  A , a , B '), ['A', 'B']);
});

function meetingDocument() {
  const nodes = new Map();
  function createElement(tag) {
    const handlers = new Map();
    return {
      tag, children: [], dataset: {}, value: '', textContent: '',
      get options() { return this.children; },
      append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } },
      replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
      cloneNode(deep) {
        const clone = Object.assign(createElement(this.tag), {textContent:this.textContent, className:this.className});
        if (deep) clone.append(...this.children.map(child => child.cloneNode(true)));
        return clone;
      },
      querySelectorAll(selector) {
        return this.children.flatMap(child => [ ...(child.tag === selector ? [child] : []), ...child.querySelectorAll(selector)]);
      },
      remove() { this.parent.children = this.parent.children.filter(child => child !== this); },
      focus() { this.focused = true; },
      addEventListener(name, fn) { handlers.set(name, fn); },
      fire(name) { return handlers.get(name)?.({preventDefault() {}}); },
    };
  }
  const document = {
    createElement,
    createTextNode(text) { return Object.assign(createElement('#text'), {textContent: text}); },
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, createElement('div'));
      return nodes.get(id);
    },
  };
  return document;
}

test('print preview uses the saved notes and clears output when its view changes', () => {
  const document = meetingDocument();
  const get = id => document.getElementById(id);
  const dialog = get('meeting-print-dialog');
  const owned = get('print-meeting');
  const shared = get('print-shared-meeting');
  const approval = get('meeting-print-confirm');
  const attributes = new Map();
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.fire('close'); };
  document.body = {
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: key => attributes.delete(key),
  };
  document.title = 'Meetings';
  let prints = 0;
  document.defaultView = {print: () => { prints += 1; }};
  const meeting = {title:'Delivery', summary:'<img src="unexpected">', transcript:'Private transcript',
    revision:4, action_items:[{text:'Inspect the delivery', owner:'Alice', due_date:'2027-02-01', done:true}]};
  let context = {owner:'account', workspace:'work', meeting, shared:false};
  const printer = mountMeetingPrint(document, {context:() => context, formatTime:() => '2026/11/24'});
  printer.sync(true);
  owned.fire('click');
  assert.equal(dialog.open, undefined);
  printer.sync();
  owned.fire('click');
  assert.equal(document.title, meeting.title);
  const report = get('meeting-print-paper');
  const content = report.querySelectorAll('p').map(node => node.textContent).join('\n');
  assert.match(content, /<img src="unexpected">/);
  assert.match(content, /Inspect the delivery/);
  assert.match(content, /已完成.*Alice/);
  assert.equal(report.querySelectorAll('time')[0].textContent, ' · 截止日期 2027-02-01');
  assert.doesNotMatch(content, /Private transcript/);
  assert.equal(report.querySelectorAll('img').length, 0);
  approval.fire('click');
  assert.equal(prints, 1);
  context = {...context, workspace:'another'};
  approval.fire('click');
  assert.equal(prints, 1);
  assert.equal(dialog.open, false);
  assert.equal(document.title, 'Meetings');
  assert.deepEqual(report.children, []);
  assert.equal(attributes.size, 0);

  context = {...context, shared:true};
  printer.sync();
  assert.equal(owned.hidden, true);
  assert.equal(shared.hidden, false);
});

test('a received meeting revoked during draft preparation cannot become a chat draft', async () => {
  const document = meetingDocument();
  const get = id => document.getElementById(id);
  const owner = 'a'.repeat(32), source = 'b'.repeat(32), personal = 'c'.repeat(32), agent = 'd'.repeat(32);
  const meeting = {id:'e'.repeat(32), shared:true, revision:2, title:'Received', summary:'Shared notes', transcript:'Private transcript'};
  const dialog = get('meeting-discussion-dialog');
  dialog.showModal = () => { dialog.open = true; };
  const stored = new Map();
  document.defaultView = {sessionStorage:{
    getItem: key => stored.get(key),
    setItem: (key, value) => { stored.set(key, value); },
    removeItem: key => { stored.delete(key); },
  }};
  const checked = '/v1/workspaces/'+source+'/meetings/shared/'+meeting.id;
  const prepared = checked+'/discussion';
  const reads = [];
  let sourceReads = 0;
  const discussion = mountMeetingDiscussion(document, {
    context: () => ({owner, workspace:source, meeting, shared:true}),
    isDirty: () => false,
    openChat: () => assert.fail('revoked source opened a draft'),
    key: () => 'meeting-discussion-' + 'a'.repeat(32),
    async request(method, path, body) {
      reads.push([method,path]);
      if (path === '/v1/auth/session') return {status:200,body:{user:{id:owner,username:'reader'}}};
      if (path === '/v1/personal-agent') return {status:200,body:{personal_agent:{workspace:{id:personal},agent:{id:agent}}}};
      if (path === checked) {
        if (++sourceReads === 2) return {status:404,body:{}};
        return {status:200,body:{meeting,viewer_username:'reader',received:true}};
      }
      assert.deepEqual([method,path,body],['POST',prepared,{revision:2}]);
      return {status:200,body:{discussion:{id:'f'.repeat(32),workspace_id:personal,agent_id:agent},viewer_username:'reader'}};
    },
  });
  discussion.sync();
  assert.equal(get('shared-meeting-discussion-entry').hidden,false);
  await get('shared-meeting-discussion').fire('click');
  assert.doesNotMatch(get('meeting-discussion-preview').value,/Private transcript/);
  assert.equal(get('meeting-discussion-transcript-option').hidden,true);
  assert.deepEqual(reads,[]);
  await get('meeting-discussion-form').fire('submit');
  assert.deepEqual(reads.filter(([method])=>method==='POST'),[['POST',prepared]]);
  assert.deepEqual(reads.at(-1),['GET',checked]);
  assert.match(get('meeting-discussion-status').textContent,/已撤回/);
  assert.equal(get('meeting-discussion-preview').value,'');
  assert.equal(get('meeting-discussion-submit').disabled,true);
  assert.doesNotMatch([...stored.values()].join(' '),/Shared notes/);
});

test('a handed-off call recording stays local and only explicit removal deletes its handoff', async () => {
  const document = meetingDocument();
  const element = id => document.getElementById('meeting-audio-' + id);
  element('preview').removeAttribute = name => { delete element('preview')[name]; };
  const audio = mountMeetingAudio(document, {
    request() { assert.fail('showing a recording should not upload audio'); },
    base: () => '/v1/workspaces/fixture/meetings',
    transcript: {value: ''},
  });
  let removals = 0;
  const discard = async () => { removals += 1; };
  const handedOff = new Blob(['browser audio'], {type:'audio/webm;codecs=opus'});
  const clip = {blob:handedOff, discard};
  assert.equal(audio.acceptCallRecording({blob:new Blob(['video'], {type:'video/webm'}), discard}), false);
  assert.equal(audio.acceptCallRecording(clip), true);
  const url = element('preview').src;
  assert.match(url, /^blob:/);
  assert.equal(element('preview').hidden, false);
  assert.equal(audio.hasPendingWork(), false);
  assert.equal(audio.acceptCallRecording({blob:new Blob(['second recording'], {type:'audio/ogg'}), discard}), false);
  assert.equal(element('preview').src, url);
  assert.equal(element('start').disabled, true);
  audio.reset();
  assert.equal(audio.hasPendingWork(), false);
  assert.equal(element('preview').hidden, true);
  assert.equal(removals, 0);
  assert.equal(audio.acceptCallRecording(clip), true);
  await element('discard').fire('click');
  assert.equal(removals, 1);
  assert.equal(element('preview').hidden, true);
  assert.equal(element('preview').src, undefined);
});

test('meeting transcript locate uses literal matches and never changes the saved text', () => {
  const document = meetingDocument();
  const element = id => document.getElementById('meeting-transcript-' + id);
  const transcript = document.createElement('textarea');
  const source = '😀 预计 [v2] 周一上线。\n确认 [V2] 的结果。';
  transcript.value = source;
  transcript.setSelectionRange = (start, end) => { transcript.selected = transcript.value.slice(start, end); };
  transcript.scrollIntoView = () => {};
  const search = mountTranscriptSearch(document, transcript);
  search.open('[v2]');
  const passage = element('hit');
  assert.equal(passage.focused, true);
  assert.equal(passage.children[1].tag, 'mark');
  assert.equal(passage.children[1].textContent, '[v2]');
  assert.match(element('search-status').textContent, /第 1 处，共 2 处/);
  element('next').fire('click');
  assert.equal(passage.children[1].textContent, '[V2]');
  element('location').fire('click');
  assert.equal(transcript.focused, true);
  assert.equal(transcript.selected, '[V2]');
  assert.equal(transcript.value, source);
  element('next').fire('click');
  assert.match(element('search-status').textContent, /第 1 处/);
  element('prev').fire('click');
  assert.match(element('search-status').textContent, /第 2 处/);
  search.reset();
  assert.equal(passage.hidden, true);
  assert.deepEqual(passage.children, []);
});

test('meeting sharing sends only the saved revision and selected account, then confirms revocation', async () => {
  const document = meetingDocument();
  const element = id => document.getElementById(id);
  const control = name => element('meeting-share-' + name);
  const dialog = control('dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.fire('close'); };
  const source = {id: 'source', title: '部署复盘', revision: 3, transcript: 'private transcript'};
  const sent = {id: 'sent', title: '部署复盘', revision: 3, recipients: ['成员甲']};
  const attempts = [];
  let saved = false;
  let revoked = false;
  let current = source;
  let historyReads = 0;
  const sharing = mountMeetingShares(document, {
    context: () => current ? {workspace: 'ws-1', meeting: current} : null,
    historyWorkspace: () => 'ws-1',
    key: () => 'idempotent-share-key',
    async request(method, path, body, headers) {
      if (path.endsWith('/social/conversations?limit=100')) return {status: 200, body: {items: [
        {id: 'group-1', kind: 'group', title: '工程群'},
        {id: 'public', kind: 'dm', public_agent: true},
      ]}};
      if (path.endsWith('/share-recipients?conversation_id=group-1')) return {status: 200, body: {items: [
        {id: 'account-a', name: '成员甲'}, {id: 'account-b', name: '成员乙'},
      ]}};
      if (path.endsWith('/shared/sent/revoke')) {
        revoked = true;
        return {status: 200};
      }
      if (path.endsWith('/shared?sent=1&limit=100')) historyReads += 1;
      if (method === 'GET') return {status: 200, body: {items: saved ? [sent] : []}};
      attempts.push({path, body, headers});
      if (attempts.length === 1) return {status: 503, body: {}};
      saved = true;
      return {status: 201, body: {meeting: sent}};
    },
  });
  sharing.sync();
  await element('share-meeting').fire('click');
  const select = control('conversation');
  assert.deepEqual(select.options.map(option => option.value), ['', 'group-1']);
  source.revision = 4;
  select.value = 'group-1';
  await select.fire('change');
  const first = control('recipient-items').children[0].children[0];
  first.checked = true;
  first.fire('change');
  const form = control('form');
  await form.fire('submit');
  assert.equal(first.checked, true);
  await form.fire('submit');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.checked, false);
  assert.deepEqual(attempts, Array(2).fill({
    path: '/v1/workspaces/ws-1/meetings/source/shares',
    body: {revision: 3, conversation_id: 'group-1', recipient_ids: ['account-a']},
    headers: {'Idempotency-Key': 'idempotent-share-key'},
  }));
  await control('close').fire('click');
  current = null;
  sharing.sync();
  assert.equal(element('share-meeting').hidden, true);
  assert.equal(element('meeting-shares-history').hidden, false);
  await element('meeting-shares-history').fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(historyReads, 1);
  assert.equal(form.hidden, true, 'share history opens independently after source deletion');
  const row = control('sent').children[0];
  assert.equal(row.children[0].textContent, '部署复盘');
  const actions = row.children.at(-1);
  actions.children[0].fire('click');
  assert.equal(revoked, false);
  await actions.children.find(button => button.className === 'meeting-share-revoke-confirm').fire('click');
  assert.equal(revoked, true);
  assert.equal(control('sent').children.length, 0);
  assert.equal(control('close').focused, true);
});

test('an unconfirmed meeting share keeps its exact retry key through reload until acknowledged', async () => {
  const owner = 'a'.repeat(32);
  const workspace = 'b'.repeat(32);
  const meeting = {id:'c'.repeat(32), title:'Private meeting title', revision:3, transcript:'Private transcript'};
  const receipts = [];
  const storage = new Map();
  let keyCount = 0;
  async function confirm({actor=owner, scope=workspace, revision=3, group='otc_a', to='otf_a', acknowledged=false}={}) {
    const document = meetingDocument();
    document.defaultView = {sessionStorage:{
      getItem: key => storage.get(key),
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: key => { storage.delete(key); },
    }};
    const get = name => document.getElementById('meeting-share-' + name);
    get('dialog').showModal = () => { get('dialog').open = true; };
    mountMeetingShares(document, {
      context: () => ({owner:actor, workspace:scope, meeting:{...meeting, revision}}),
      key: () => 'meeting-share-' + String(++keyCount).padStart(16, '0'),
      async request(method, path, body, headers) {
        if (method === 'POST') {
          receipts.push(headers['Idempotency-Key']);
          return acknowledged ? {status:200,body:{meeting:{...meeting,id:'d'.repeat(32)}}} : {status:503,body:{}};
        }
        const items = path.includes('/social/conversations') ? [{id:'otc_a',kind:'group'},{id:'otc_b',kind:'group'}]
          : path.includes('/share-recipients') ? [{id:'otf_a',name:'Recipient name'},{id:'otf_b',name:'Other person'}] : [];
        return {status:200,body:{items}};
      },
    });
    const before = receipts.length;
    await document.getElementById('share-meeting').fire('click');
    get('conversation').value = group;
    await get('conversation').fire('change');
    const recipient = get('recipient-items').children.map(label=>label.children[0]).find(box=>box.value===to);
    recipient.checked = true;
    recipient.fire('change');
    assert.equal(receipts.length,before,'reopening and reselecting never send');
    await get('form').fire('submit');
    return receipts.at(-1);
  }
  const first = await confirm();
  const stored = [...storage.values()].join('');
  assert.match(stored,new RegExp(first));
  assert.doesNotMatch(stored,/Private meeting title|Private transcript|Recipient name|Other person/);
  assert.notEqual(await confirm({actor:'e'.repeat(32),acknowledged:true}),first);
  assert.notEqual(await confirm({scope:'f'.repeat(32),acknowledged:true}),first);
  assert.notEqual(await confirm({revision:4,acknowledged:true}),first);
  assert.notEqual(await confirm({group:'otc_b',acknowledged:true}),first);
  assert.notEqual(await confirm({to:'otf_b',acknowledged:true}),first);
  assert.equal(await confirm({acknowledged:true}),first);
  assert.equal(storage.size,0);
  assert.notEqual(await confirm(),first,'a later deliberate share receives a new key');
});

test('a receipt renders the shared summary and action status as read-only text', () => {
  const document = meetingDocument();
  const element = id => document.getElementById(id);
  renderSharedMeeting(document, {
    title: '只读复盘', organizer: '分享者', revision: 2,
    started_at: 1700000000, summary: '<em>保留原文</em>',
    transcript: 'private transcript', action_items: [{text: '核对版本', owner: '成员甲', due_date: '2032-02-29', done: true}],
  });
  assert.equal(element('shared-meeting-detail').hidden, false);
  assert.equal(element('shared-meeting-title').textContent, '只读复盘');
  assert.match(element('shared-meeting-meta').textContent, /组织者 分享者.*版本 2/);
  assert.equal(element('shared-meeting-summary').textContent, '<em>保留原文</em>');
  assert.deepEqual(element('shared-meeting-actions').children[0].children.map(node => [node.tag, node.textContent]),
    [['p', '核对版本'], ['p', '负责人 成员甲 · 截止日期 2032-02-29 · 已完成']]);
});
