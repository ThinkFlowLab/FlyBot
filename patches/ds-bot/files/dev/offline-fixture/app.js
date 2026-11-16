import {createElement as h, useState, useEffect, Component} from 'react'
import {createRoot} from 'react-dom/client'
import {SettingsDialog} from '../../src/client/settings.js'
import {MemoryDialog} from '../../src/client/memory-panel.js'
import {NewGroupForm, GROUP_SETTINGS_CSS} from '../../src/client/group-settings.js'
import {TeamSidebar, SIDEBAR_CSS} from '../../src/client/sidebar.js'
import {HeaderPill} from '../../src/client/header.js'
import {CommandPalette} from '../../src/client/palette.js'
import {FoldedContent, DocumentPane, foldingOf} from '../../src/client/message-fold.js'
import {MessageTools, onMessageContextMenu} from '../../src/client/message-tools.js'
import {installSendShortcut} from '../../src/client/composer.js'
import {isDarkAppearance, applyAppearanceAttribute} from '../../src/client/appearance.js'
import {SHELL_CSS, CONVERSATION_CSS} from '../../src/client/styles.js'
import {MOBILE_CSS} from '../../src/client/mobile.js'
import {installLocale, DICTIONARY} from '../../src/client/i18n.js'
export const routes = ['chat','settings','memory','group','search']
const longText = '# 示例离线文档\n'+['背景','方案','边界'].map(x=>'## '+x+'\n'+('这段内容是示例数据，不代表真实对话。'.repeat(35))+'\n').join('\n')
const bot = (id,name) => ({id,name,role:'示例 Bot',createdAt:1,parts:[id],look:{}})
const bots = [bot('demo-a','示例助手 A'),bot('demo-b','示例助手 B'),bot('demo-c','示例助手 C')]
const room = {id:'demo-group',name:'示例讨论组',admin:'demo-a',members:['demo-a','demo-b'],createdAt:1}
const entries = [{scope:'own',topic:'偏好',text:'示例：回复使用中文。',id:'sample-1'},{scope:'team',topic:'项目',text:'示例：仅本地验证，不部署。',id:'sample-2'}]
const memory = {entries,summary:{at:Date.now(),text:'# 示例记忆\n仅用于离线验证。'},fresh:true,summarizing:false,sizes:{own:12,team:15},limits:{main:4000}}
const sessions = {ids:['demo-a','demo-b','demo-c','demo-group'],byId:Object.fromEntries([...bots,room].map(x=>[x.id,{id:x.id,displayTitle:x.name,updatedAt:1,projectionValues:{turnOutline:[{turn:0,prompt:'示例搜索 kiwi',response:'示例回答：本地 fixture'}]}}]))}
const select = value => Object.assign(pick => pick(value), {getSnapshot:()=>value})
class Boundary extends Component {
  constructor(props){ super(props); this.state={error:null} }
  static getDerivedStateFromError(error){return {error:String(error.stack ?? error)}}
  render(){return this.state.error ? h('pre',{role:'alert'},'Fixture render failed (not hidden):\n'+this.state.error) : this.props.children}
}
export function App({initialRoute='chat',initialLocked=false,initialLang='zh'}={}) {
 const [route,setRoute]=useState(initialRoute), [prefs,setPrefs]=useState({appearance:{mode:'light'},folding:{mode:'standard',documentCards:true}})
 const [locked,setLocked]=useState(initialLocked),[lang,setLang]=useState(initialLang),[active,setActive]=useState('demo-a')
 const [unread,setUnread]=useState({'demo-b':true}),[rooms,setRooms]=useState([room]),[flags,setFlags]=useState({}),[doc,setDoc]=useState(null),[streaming,setStreaming]=useState(false)
 const [quote,setQuote]=useState(''),[sent,setSent]=useState(0),[log,setLog]=useState([]),[reactions,setReactions]=useState([]),[contextAt,setContext]=useState(null),[page,setPage]=useState('general')
 const note=text=>setLog(old=>[String(text),...old].slice(0,8))
 const roster={bots:bots.map(x=>({...x,...flags[x.id]})),rooms:rooms.map(x=>({...x,...flags[x.id]})),agents:[],prefs,exchangeTurns:{},questions:{},self:{name:'示例用户'},mainBotId:null,readOnly:locked?'离线示例：只读窗口。':'',themes:[],projects:[]}
 roster.byId=Object.fromEntries(roster.bots.map(x=>[x.id,x]));roster.roomsById=Object.fromEntries(roster.rooms.map(x=>[x.id,x]))
 const actions={
  reportError:e=>note(e?.message??e),
  setPrefs:async patch=>{if(locked)throw Error('Mock host: read-only');setPrefs(p=>({...p,...patch}));note('mock set-prefs '+JSON.stringify(patch))},
  setFlags:async(id,patch)=>{if(locked)throw Error('Mock host: read-only');setFlags(old=>({...old,[id]:{...old[id],...patch}}));note('mock setFlags '+id)},
  markUnread:id=>{setUnread(old=>({...old,[id]:true}));note(`manual unread ${id}=true`)},
  clearUnread:id=>{setUnread(old=>({...old,[id]:false}));note(`manual unread ${id}=false; system status untouched`)},
  openMenu:()=>note('示例边界：会话行菜单未挂载，请用真实顶栏菜单验证未读/置顶'),
  openInbox:()=>note('示例边界：inbox 不在本轮 fixture 范围'),
  openConnectors:()=>note('示例边界：连接器不接入真实宿主'),
  selectPanel:()=>note('示例边界：宿主面板未接入'),
  openSession:id=>{setActive(id);setUnread(old=>({...old,[id]:false}));setRoute('chat')},
  openSettings:next=>{setPage(next??'general');setRoute('settings')},closeSettings:()=>setRoute('chat'),
  openPalette:()=>setRoute('search'),closePalette:()=>setRoute('chat'),openNewChat:()=>setRoute('group'),
  openMemory:()=>setRoute('memory'),closeMemory:()=>setRoute('chat'),memoryView:async()=>memory,
  memoryAsk:async()=>{throw Error('离线 fixture 不模拟模型回答或持久化记忆')},memoryForget:async()=>{throw Error('离线 fixture 不写入记忆')},
  createRoom:async(ids,opts)=>{if(locked)throw Error('Mock host: read-only');const next={id:'demo-created-'+rooms.length,members:ids,...opts};setRooms(old=>[...old,next]);note('mock createRoom '+JSON.stringify(next));return next},
  quote:(_,text)=>{setQuote('> '+text.split('\n').join('\n> ')+'\n\n');note('quoted into mock composer')},
  openDocument:setDoc,toggleDetails:()=>note('宿主详情抽屉未接入 fixture'),reloadTeam:async()=>note('mock reload only'),
 }
 const useRoster=select(roster),useUi=select({unread,visits:{}}),useSessions=select(sessions),empty=select({})
 const useSessionStatus=select(new Map([['demo-c',{completionUnread:true}]]))
 const props={actions,useRoster,useUi,useSessions,useSessionStatus,useRegistry:empty,useActivity:empty,useSessionRetainInfo:(_,pick)=>pick({retainedBy:{mainView:0}}),useUpdate:select(null),useTurnClock:empty,useSession:empty,useBusyAcks:empty,useLive:empty}
 installLocale({register:()=>()=>{},bind:()=> (key,params)=>{const text=(lang==='zh'?DICTIONARY.zh[key]:null)??key;return text.replace(/\{(\w+)\}/g,(m,k)=>params?.[k]??m)},getLocale:()=>({active:lang}),setLocale:async tag=>setLang(tag)})
 useEffect(()=>installSendShortcut(useRoster),[prefs,locked])
 useEffect(()=>{applyAppearanceAttribute(isDarkAppearance(prefs));},[prefs])
 const button=(label,click)=>h('button',{type:'button',onClick:click},label)
 const composer=h('div',{'data-composer-card':'',style:{marginTop:16}},h('label',null,'模拟宿主输入框（真实 installSendShortcut）',h('textarea',{'data-composer-input':'',defaultValue:quote,key:quote,readOnly:locked,rows:5,style:{display:'block',width:'100%'}})),h('button',{type:'button','data-send':'',disabled:locked,onClick:()=>{setSent(n=>n+1);note('mock send: no network')}},'发送（仅本地计数）'),h('output',null,` 已触发 ${sent} 次`))
 const chat=h('div',null,h(HeaderPill,{...props,sessionId:active}),
  h('label',null,h('input',{type:'checkbox',checked:streaming,onChange:e=>setStreaming(e.target.checked)}),'模拟 streaming（只改变 prop，不模拟 token 传输）'),
  h('article',{className:'bt-bubble',onContextMenu:e=>onMessageContextMenu(e,setContext,{live:streaming})},
   h(FoldedContent,{text:longText,folding:foldingOf(prefs),streaming,actions,sessionId:active},text=>h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},text)),
   !streaming?h(MessageTools,{text:longText,name:'fixture',sessionId:active,roster,actions,contextAt,react:emoji=>{setReactions(old=>[...old,emoji]);note('local reaction '+emoji)}}):null),
  h('output',null,reactions.join(' ')),composer,doc?h(DocumentPane,{document:doc,onClose:()=>setDoc(null)}):null)
 const view=route==='settings'?h(SettingsDialog,{page,roster,actions,useUpdate:select(null)}):route==='memory'?h(MemoryDialog,{bot:bots[0],roster,actions}):route==='group'?h(NewGroupForm,{roster,actions,run:async promise=>{try{await promise;return true}catch(e){note(e.message);return false}},onCancel:()=>setRoute('chat'),onCreated:()=>setRoute('chat')}):route==='search'?h(CommandPalette,{roster,actions,useSessions,token:'fixture'}):chat
 return h('div',null,h('style',null,SHELL_CSS+CONVERSATION_CSS+SIDEBAR_CSS+GROUP_SETTINGS_CSS+MOBILE_CSS+'\nbody{margin:0;background:var(--bt-main);color:var(--bt-ink);font:14px system-ui}button,input,textarea{font:inherit} .fixture-bar{position:relative;z-index:2147483647;padding:10px;background:var(--bt-card);border-bottom:2px solid #fa0;display:flex;gap:8px;flex-wrap:wrap}.fixture-layout{display:grid;grid-template-columns:290px minmax(0,1fr);gap:18px;padding:12px}.fixture-layout main{min-width:0}.fixture-log{white-space:pre-wrap;overflow-wrap:anywhere} @media(max-width:640px){.fixture-layout{grid-template-columns:1fr}}'),
 h('header',{className:'fixture-bar'},h('strong',null,'FlyBot — 真实源码组件 / 示例数据 / MOCK HOST / 非实机验收'),...routes.map(r=>button(r,()=>setRoute(r))),button(locked?'切换可写':'切换只读',()=>setLocked(x=>!x)),button(lang==='zh'?'English':'中文',()=>setLang(x=>x==='zh'?'en':'zh'))),
 h('div',{className:'fixture-layout'},h('aside',null,h(TeamSidebar,{...props,wide:true})),h('main',null,h(Boundary,{key:route+locked},view),h('pre',{className:'fixture-log','aria-label':'Mock host operation log'},log.join('\n')))))
}
if (typeof document!=='undefined') createRoot(document.getElementById('root')).render(h(App,{initialRoute:location.hash.slice(1)||'chat'}))
