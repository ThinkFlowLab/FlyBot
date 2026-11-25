#!/usr/bin/env python3
"""Upgrade two disposable real DS-Bot volumes from v0.3.9 to v0.3.10, then verify
each account in a separate Playwright Chromium context before/after a restart.

Usage on a Linux Docker/Playwright runner, from the candidate repo:
  python3 /path/to/check.py --repo . --baseline ot-dsbot-before:test --candidate ot-dsbot-after:test

Images must already exist locally. This harness creates uniquely named test-only
containers/network/volumes and mounts no existing account volume. It tests
container state migration and browser routing. It does not test the production
manager's immutable image/digest adoption workflow.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit
from uuid import uuid4
from wsgiref.simple_server import make_server

HERE = Path(__file__).resolve().parent
PACKAGE = '/opt/flybot-workspace/runtime/ds-bot-upstream/ds-bot/package.json'

VOLUME_PROBE = r"""
const fs = require('node:fs')
const { DatabaseSync } = require('node:sqlite')
const s = JSON.parse(fs.readFileSync('/data/bot/state.json'))
const a = JSON.parse(process.argv[1])
const original = s.bots[a.botId]
const chief = s.bots[s.mainBotIds[0]]
const task = (original?.tasks ?? []).find(task => task.id === a.taskId)
if (!original || !chief || !task) throw Error('Native Chief, original Bot, or unrelated task was lost')
const db = new DatabaseSync('/data/flybot-workspace/features/agents/agents.sqlite3', {readOnly:true})
const binding = db.prepare('SELECT bot_id FROM native_agent_objects WHERE agent_id=?').get(a.agentId)
const thread = part => ({head:part.sessionId ?? part.id, segments:(part.segments ?? []).map(segment=>segment.sessionId)})
const data = {
  sentinel: fs.readFileSync('/data/volume-sentinel', 'utf8'),
  workspace: chief.flybotWorkspace?.workspace_id,
  agent: chief.flybotWorkspace?.agent_id,
  sameChief: binding?.bot_id === chief.id,
  originalStillBound: original !== chief && original.flybotWorkspace?.agent_id === a.agentId,
  parts: [thread(chief), ...(chief.openParts ?? []).map(thread)],
  task: {id:task.id, sessionId:task.sessionId, status:task.status},
  retired: (s.retiredParts ?? []).map(part=>part.sessionId),
}
console.log(JSON.stringify(data))
"""


def argv_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--candidate', required=True)
    return parser


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def load_gateway_fixture(repo):
    path = repo / 'runtime/flybot-image/test/container-gateway-isolation.py'
    spec = importlib.util.spec_from_file_location('upgrade_gateway_fixture', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(args):
    repo = args.repo.resolve()
    require(repo.is_dir() and (repo / 'flybot_workspace/dsbot_gateway.py').is_file(), 'provide the exact candidate repository')
    require(shutil.which('docker'), 'Docker is required to exercise actual upgraded volumes')
    require((HERE / 'volume-fixture.mjs').is_file() and (HERE / 'check-browser.mjs').is_file(), 'copy all three test files')
    sys.path.insert(0, str(repo))
    base = load_gateway_fixture(repo)
    from flybot_workspace.app import App, Config
    from flybot_workspace.security import password_hash
    from flybot_workspace.settings_page import SettingsPage

    def image(name, expected):
        # Resolve before touching Docker volumes. All launches use the resolved
        # local image ID; moving a tag mid-test cannot change which image boots.
        found = base.docker('image', 'inspect', name).stdout
        info = json.loads(found)[0]
        ref = info['Id']
        require(bool(re.fullmatch(r'sha256:[a-f0-9]{64}', ref)), 'invalid image ID')
        raw = base.docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', ref,
                          '-p', f"require('{PACKAGE}').version").stdout
        require(raw.strip() == expected, f'expected DS-Bot {expected}, found {raw.strip()!r}')
        return ref

    before = image(args.baseline, '0.3.9')
    after = image(args.candidate, '0.3.10')
    require(before != after, 'baseline and candidate images must be distinct')
    run_id = uuid4().hex[:10]
    network = 'ot-upgrade-' + run_id
    edge = network + '-edge'
    accounts = [{'name':network + '-' + label, 'id':uuid4().hex} for label in ('a','b')]
    for account in accounts:
        account['volume'] = account['name'] + '-data'
    gateway_key = secrets.token_urlsafe(32)
    base.SECRETS.append(gateway_key)
    httpd = None
    serving = False
    started = set()
    network_created = False

    def start(account, ref):
        base.IMAGE = ref
        started.add(account['name'])
        # The fixture volume retains the same native identity across image swaps.
        base.start_runtime(account['name'], network, account['id'], volume_id=account['id'])
        account['containerId'] = base.docker('inspect', '-f', '{{.Id}}', account['name']).stdout.strip()
        account['address'] = base.gw.validate_address(base.ip_on(account['name'], network)+':8080')
        base.wait_for(lambda: base.request(account['address'],'GET','/',{'Host':account['address']})[0] in (200,401),
                      account['name']+' HTTP')
        url = base.launch_url(account['name'])
        account['cookie'] = base.wait_for(lambda: base.gw.exchange_launch_url(url,account['address']),
                                           account['name']+' session')
        base.SECRETS.append(account['cookie'].split('=',1)[1])
        volumes = json.loads(base.docker('inspect','-f','{{json .Mounts}}',account['name']).stdout)
        data = [m for m in volumes if m['Destination']=='/data']
        require(len(data)==1 and data[0].get('Name')==account['volume'] and data[0]['RW'], 'account must retain its exact volume')

    def start_model(account, *, install=False):
        if install:
            base.docker('exec',account['name'],'node','-e',base.FAKE_MODEL_WRITE)
        base.docker('exec','-d',account['name'],'node','-e',base.FAKE_MODEL_SERVER)
        base.wait_for(lambda: base.docker('exec',account['name'],'node','-e',base.FAKE_MODEL_PROBE,check=False).returncode==0,
                      'account loopback model')

    def stop(account):
        base.docker('stop','--time','20',account['name'])
        base.docker('rm',account['name'])
        started.remove(account['name'])

    def assert_app_state(account):
        checkpoint = account['view']
        out = base.docker('exec',account['name'],'node','-e',VOLUME_PROBE,json.dumps(checkpoint)).stdout
        state = json.loads(out)
        require(state['sentinel']==checkpoint['sentinel'],'volume sentinel lost')
        require(state.get('workspace')==checkpoint['workspaceId'] and state.get('agent')==checkpoint['agentId']
                and state['sameChief'] and not state['originalStillBound'], 'Personal Agent is not bound to its native Chief')
        first, second, prior, task = checkpoint['conversations']
        independent = next((part for part in state['parts'] if part['head']==second['sessionId']),None)
        require(independent is not None,'the independent conversation changed its native root')
        open_part = next((part for part in state['parts'] if part['head']==first['sessionId']),None)
        require(open_part and open_part['segments']==[prior['sessionId']],
                'managed migration must keep the legacy private part and its earlier segment')
        require(prior['sessionId'] not in independent['segments'] and first['sessionId'] not in independent['segments'],
                'another conversation was folded into the independent thread')
        require(state['task']=={
            'id':checkpoint['taskId'],
            'sessionId':task['sessionId'],
            'status':'done',
        },'closed unrelated task must keep its own session')
        require(all(task['sessionId'] != part['head'] and task['sessionId'] not in part['segments']
                    for part in state['parts']), 'settled task entered Chief chat parts')
        require(first['sessionId'] not in state['retired'],'managed private part was scheduled to retire')
        return state

    with tempfile.TemporaryDirectory(prefix='ot-upgrade-') as path:
        temp = Path(path).resolve()
        try:
            base.docker('network','create','--driver','bridge','--label','io.flybot-workspace.ci=runtime-upgrade',network)
            network_created = True
            bridge = json.loads(base.docker('network','inspect',network).stdout)[0]['IPAM']['Config'][0]['Gateway']
            for account in accounts:
                start(account,before)
                start_model(account,install=True)
            store = base.Store(str(temp/'platform'))
            for account, token in zip(accounts, base.seed(store,accounts,int(time.time())), strict=True):
                account['platformToken']=token

            httpd = make_server(bridge,0,lambda env,response:None,handler_class=base.QuietHandler,
                                 server_class=base.ThreadedWSGIServer)
            conf = base.gw.nginx_config(base.gw.load_routes(),f'{bridge}:{httpd.server_port}',8081,key=gateway_key)
            # The runner uses an ephemeral public port. Preserve it in the
            # Host forwarded to the platform's exact same-origin check.
            conf = conf.replace('proxy_set_header Host $host;', 'proxy_set_header Host $http_host;')
            conf_file = temp/'nginx.conf'
            conf_file.write_text(conf)
            conf_file.chmod(0o644)
            base.docker('run','--detach','--name',edge,'--network',network,'--read-only',
                        '--tmpfs','/var/cache/nginx','--tmpfs','/var/run','--tmpfs','/tmp',
                        '-p','127.0.0.1::8081/tcp','--mount',f'type=bind,src={conf_file},dst=/etc/nginx/conf.d/default.conf,readonly',
                        base.NGINX)
            started.add(edge)
            mapping = base.docker('port',edge,'8081/tcp').stdout.strip()
            require(bool(re.fullmatch(r'127\.0\.0\.1:[0-9]+',mapping)), 'expected only a test loopback HTTP port')
            origin = 'http://'+mapping
            app = SettingsPage(App(store,Config(origin=origin,insecure_local=True)))
            httpd.set_app(base.gw.mount(app,base.gw.GatewayApp(store,origin,base.COOKIE,gateway_key)))
            threading.Thread(target=httpd.serve_forever,daemon=True).start()
            serving = True

            def login_response():
                status, _, content = base.request(mapping,'GET','/login')
                return (status, content) if status not in (502, 503) else None

            status, content = base.wait_for(login_response,'edge login')
            require(status==200,f'edge login returned {status}: {base.redact(content[:200])}')

            def api(account, method, path, data=None, expected=200):
                headers = {'Host':urlsplit(origin).netloc,'Origin':origin,'Cookie':f"{base.COOKIE}={account['platformToken']}"}
                if data is not None:
                    headers.update({'Content-Type':'application/json','Idempotency-Key':uuid4().hex})
                status, response_headers, raw = base.request(mapping,method,path,headers,
                    json.dumps(data) if data is not None else None,timeout=150)
                require(status==expected,f'{method} {path} returned {status}: {base.redact(raw[:280])}')
                require(not any(value.startswith('dsh-auth-') for value in (response_headers.get_all('Set-Cookie') or ())),
                        'runtime session cookie reached an external client')
                return json.loads(raw)

            with store.transaction() as db:
                for index,account in enumerate(accounts):
                    username = f'ci-gateway-user-{index}'
                    password = secrets.token_urlsafe(20) + 'Upgrade'
                    account['password']=password
                    account['username']=username
                    base.SECRETS.append(password)
                    db.execute('UPDATE users SET password_hash=? WHERE username=?',(password_hash(password),username))
                    db.execute('UPDATE instances SET image_ref=?, volume_ref=? WHERE id=?',(before,account['volume'],account['id']))

            for index,account in enumerate(accounts):
                agent_root='/v1/workspaces/'+account['workspace_id']+'/agents'
                created=api(account,'POST',agent_root,{'name':'Upgrade Assistant '+str(index),'instructions':'CI-PROFILE-MARK'},201)['agent']
                require(created['served_by']=='ds-bot' and created['native_bot_id'],'agent is not an owned native Bot')
                root=agent_root+'/'+created['id']+'/conversations'
                binding=api(account,'POST','/b/api/flybot-workspace',{'endpoint':'agents/adopt-personal-chat','payload':{
                    'workspace_id':account['workspace_id'],'id':created['id'],'conversations':[]}})
                require(binding.get('ok'),'personal workspace was not bound')
                conversations=[]
                for slot,label in enumerate(('First private','Second private','Older part','Unrelated task')):
                    c=api(account,'POST',root,{'title':label},201)['conversation']
                    route=root+'/'+c['id']
                    marker=f'Upgrade {index} {label} retained {run_id}'
                    post_marker=f'Upgrade {index} {label} after {run_id}'
                    session_id=c['native_session_id']
                    require(session_id,'baseline did not create its native Session')
                    if slot < 2:
                        reply=api(account,'POST',route+'/messages',{'body':marker},201)['reply']
                        require(reply['status']=='succeeded' and reply['body'].startswith('CI-DSBOT-REPLY'),'baseline turn was not native')
                    else:
                        # Native UI send writes an ordinary DSH event without an
                        # FlyBot request marker. The Web projection can
                        # legitimately reconstruct it after the offline splice.
                        sent=api(account,'POST','/b/api/bot',{'endpoint':'send','payload':{'sessionId':session_id,'text':marker}})
                        require(sent.get('ok'),'native fixture turn was refused')

                        def projected():
                            messages=api(account,'GET',route)['items']
                            return (any(row['role']=='user' and row['body']==marker for row in messages)
                                    and any(row['role']=='assistant' and row['status']=='succeeded'
                                            and row['body'].startswith('CI-DSBOT-REPLY') for row in messages))
                        base.wait_for(projected,'completed native fixture turn')
                    saved=api(account,'GET',route)
                    require(saved['conversation']['native_session_id']==session_id,'baseline did not persist its native Session')
                    conversations.append({'id':c['id'],'sessionId':session_id,'marker':marker,'postUpgrade':post_marker})
                account['view']={'username':account['username'],'password':account['password'],'instanceId':account['id'],
                                 'workspaceId':account['workspace_id'],'agentId':created['id'],'botId':created['native_bot_id'],
                                 'conversations':conversations,'taskId':uuid4().hex,'taskTitle':'Unrelated settled task',
                                 'sentinel':uuid4().hex}

            def browser(phase):
                result = subprocess.run(
                    [os.environ.get('FLYBOT_WORKSPACE_UPGRADE_NODE','node'),str(HERE/'check-browser.mjs')],
                    input=json.dumps({'origin':origin,'accounts':[a['view'] for a in accounts],'phase':phase}),
                    stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,cwd=repo,timeout=420,check=False,
                )
                print(base.redact(result.stdout),end='',flush=True)
                require(result.returncode==0,'Chromium '+phase+' failed: '+base.redact(result.stderr))

            browser('baseline')
            for account in accounts:
                stop(account)
                base.docker('run','--rm','--network','none','--user','1000:1000','--entrypoint','node',
                            '--mount',f"type=volume,src={account['volume']},dst=/data",
                            '--mount',f'type=bind,src={HERE}/volume-fixture.mjs,dst=/upgrade-fixture.mjs,readonly',
                            before,'/upgrade-fixture.mjs',json.dumps({key:value for key,value in account['view'].items() if key not in ('username','password')}))

            for phase in ('upgraded','restart'):
                for account in accounts:
                    prior_container = account['containerId']
                    if phase=='restart':
                        stop(account)
                    start(account,after)
                    require(account['containerId']!=prior_container,'runtime container did not get recreated')
                    start_model(account)
                    with store.transaction() as db:
                        db.execute('UPDATE instances SET image_ref=? WHERE id=?',(after,account['id']))
                        base.gw.record_upstream(db,account['id'],account['address'],account['cookie'],int(time.time()))
                    view = account['view']
                    api(account,'GET','/v1/workspaces/'+view['workspaceId']+'/agents/'+view['agentId'])
                    assert_app_state(account)
                browser(phase)
                for account in accounts:
                    assert_app_state(account)

            print(json.dumps({'runtime_volume_upgrade':'ok','accounts':2,'baseline':'0.3.9','candidate':'0.3.10',
                              'browser':['baseline','upgraded','restart'],'distinct_image_ids':True}),flush=True)
        finally:
            if httpd is not None:
                if serving:
                    httpd.shutdown()
                httpd.server_close()
            for name in started:
                base.docker('rm','-f',name,check=False)
            if network_created:
                for account in accounts:
                    base.docker('volume','rm',account['volume'],check=False)
                base.docker('network','rm',network,check=False)


if __name__ == '__main__':
    run(argv_parser().parse_args())
