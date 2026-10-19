// FlyBot extension API (version 1). Implemented in src/host/hooks.js (host) and
// src/client/flybot-registry.js + flybot-slots.js (browser). Feature plugins declare
// `inject: ['flybot']` and use `ctx.flybot`.

export type BotId = string
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/**
 * A Bot outside this team, e.g. a friend's Bot on Bot Social. Never in bot.list().
 * Also accepted as a plain '@handle' string. FlyBot member handles are
 * '@<bot>.<home>' (home '@<home>', e.g. '@coder.bob.home' in home '@bob.home').
 */
export interface RemoteBotRef {
  kind: 'remote'
  /** Handle on the remote network, e.g. "@coder.bob.home". */
  handle: string
  /** Home handle; derived from the handle when omitted. */
  home?: string
  /** Display name used in the message header. */
  name?: string
  /** Transport that reaches it; default "bot-social". */
  transport?: string
}
export type BotRef = BotId | RemoteBotRef | `@${string}`

/** Where a message goes, as middleware sees it. */
export type SendTarget = { remote: false; id: BotId } | { remote: true; handle: string; home: string }

export interface BotView {
  id: BotId
  name: string
  role?: string
  isMain: boolean
  /** True when this Bot has at least one person-grant (Invite to this Bot was accepted). */
  granted: boolean
  createdBy: BotId | null
  /** Text prompt.js appends to this Bot's system prompt (bot.setSystemPrompt). */
  systemPrompt: string
  /** Every plugin's fields: fields[plugin][key]. Stored as state.bots[id].fields. */
  fields: Record<string, Record<string, Json>>
  /** Owner-chosen character color (named id or #rrggbb). Omitted when unset. */
  color?: string
  /** Owner-chosen avatar ({ shape }, { image }, or { emoji }). Omitted when unset. */
  avatar?: { shape?: string; image?: string; emoji?: string }
}

/** 'change' payload. Delivered for the listener's own plugin unless it subscribed with { all: true }. */
export interface FieldChange {
  botId: BotId
  plugin: string
  key: string
  /** undefined when the key was removed. */
  value: Json | undefined
  prev: Json | undefined
}

/** Fires after removal (bot.list() no longer has it); no per-field events are sent. */
export interface BotRemoved {
  botId: BotId
  /** The Bot's last record, fields included. */
  bot: BotView
}

/** Who a delivery came from. A user line, a Bot, a group (a round's call), or a friend's Bot. */
export type FeedParty = { kind: 'user' } | { kind: 'bot'; botId: BotId } | { kind: 'room'; roomId: string } | { kind: 'remote'; handle: string; /** What the user calls it ("Bob's Chief"), when the roster knows it. */ name?: string }

/**
 * Where a Session speaks: a Bot's own chat ('chat'), a Bot's hidden Session in a group
 * ('group'), the group's own Session ('room': its turn is one round and has no botId), or a
 * friend's Bot chat ('remote': the Session runs no model, it only carries lines to and from
 * the friend, so its turns are transport, not a team Bot's work; `botId` is the chat's id).
 */
export interface FeedPlace {
  place: 'chat' | 'group' | 'room' | 'remote'
  /** Set for place 'remote': the friend's handle and the chat's name. */
  remote?: { handle: string; name: string }
  /** Absent for place 'room'. */
  botId?: BotId
  /** Set for 'group' and 'room'. */
  roomId?: string
  sessionId: string
}

/** The message a turn started from, when one arrived while the Session was idle. */
export interface TurnTrigger {
  exchangeId: string
  from: FeedParty
  role: string
  hop: number
  replyTo?: string
}

export interface TurnStarted extends FeedPlace {
  /** `<sessionId>#<turn>`; tool events of the turn carry the same id. */
  turnId: string
  turn: number
  /** Epoch ms of the session event. */
  time: number
  seq?: number
  trigger?: TurnTrigger
}

export interface TurnEnded extends FeedPlace {
  turnId: string
  turn: number
  time: number
  seq?: number
  /** 'aborted' = stopped; 'error' carries `errorCode` only (no message text). */
  outcome: 'completed' | 'aborted' | 'error'
  errorCode?: string
  /** True when the turn never reported its end and a newer turn closed it. */
  interrupted?: boolean
}

export interface ToolStarted extends FeedPlace {
  turnId: string
  callId: string
  /** Cleaned label (one line, at most 80 characters). Arguments are never in the feed. */
  name: string
  time: number
}

export interface ToolEnded extends FeedPlace {
  turnId: string
  callId: string
  name: string
  time: number
  durationMs: number
  /** False for an error result, and for a call its turn ended before it returned. */
  ok: boolean
  /** True when the turn ended while the call was still running. */
  interrupted?: boolean
}

/**
 * A message delivered into a Session's log (not "read"; the feed cannot see that).
 * `exchangeId` matches `state.exchanges` and the `replyTo` of the answer, so send to
 * reply latency is the difference of two deliveries' `time`. Text is never in the feed.
 */
export interface ExchangeDelivered {
  exchangeId: string
  from: FeedParty
  to: { botId?: BotId; roomId?: string }
  sessionId: string
  place: 'chat' | 'group' | 'room' | 'remote'
  /** Set for place 'remote' (a line typed in a friend's chat, or the friend's own line). */
  remote?: { handle: string; name: string }
  /** 'user' for a typed line; 'remote' for a friend's line into its chat; else request, reply, stopped, report, room, post or mention. */
  role: string
  hop: number
  time: number
  seq?: number
  replyTo?: string
  roomId?: string
  audience?: 'user'
  /** Characters of text the message carried. */
  textLength: number
}

export interface FlyBotEvents {
  'change': FieldChange
  /** A new local Bot (UI, create_bot, or a plugin's bot.create); payload is its record. */
  'bot.created': BotView
  'bot.removed': BotRemoved
  /** This Bot's grant list changed; payload is its record. */
  'bot.grants': BotView
  /**
   * Team activity feed, folded from session events: metadata only (ids, times, outcomes),
   * never message text, tool arguments or output. Not replayed: a listener hears what
   * happens after it subscribes. Listeners cannot affect the Session.
   */
  'turn.start': TurnStarted
  'turn.end': TurnEnded
  'tool.start': ToolStarted
  'tool.end': ToolEnded
  'exchange.delivered': ExchangeDelivered
}
export type On = <K extends keyof FlyBotEvents>(event: K, listener: (payload: FlyBotEvents[K]) => void, options?: { all?: boolean }) => () => void

/** Fields of the plugin this handle is scoped to (flybot.scope(plugin)); synchronous, saved in the background. */
export interface BotFields {
  get<T extends Json = Json>(botId: BotId, key: string): T | undefined
  all(botId: BotId): Record<string, Json>
  /** null/undefined removes the key. Emits 'change' when the value differs. */
  set(botId: BotId, key: string, value: Json | undefined): void
  /** Bots that have the key; with `value`, only those whose value deep-equals it. */
  query(key: string, value?: Json): BotView[]
  on: On
}

export interface CreateBotSpec {
  name: string
  systemPrompt?: string
  /** Initial fields in the calling plugin's namespace. */
  fields?: Record<string, Json>
  role?: string
  instructions?: string
  createdBy?: BotId
}

/** What a send middleware sees. Built-in ds-bot sends arrive with via: 'ds-bot'. */
export interface SendMessage {
  from: BotId | RemoteBotRef
  to: BotId | RemoteBotRef
  /** target.remote === true for a remote Bot, with its handle and home. */
  target: SendTarget
  text: string
  role: 'request' | 'reply' | 'stopped' | 'report'
  hop: number
  /** Plugin that sent it ('ds-bot' for message_bot and replies). */
  via: string
  exchangeId: string
  meta?: Record<string, Json>
  /** Files the message carries (metadata only; bytes never pass through middleware). */
  attachments?: FileAttachment[]
}

export interface SendRequest {
  from: BotRef
  to: BotRef
  text: string
  role?: 'request' | 'reply'
  hop?: number
  meta?: Record<string, Json>
  /** Files to send with it (at most 5). A transport uploads them only after approval; the approval card lists name and size. */
  attachments?: FileAttachment[]
}

/**
 * undefined = no opinion (allow, next middleware runs). 'allow' also continues; its
 * `bypass` skips the named middleware only if config.flybot.bypass[<this name>] lists it.
 * The first 'deny' or 'hold' ends the chain. A throw counts as deny.
 */
export type SendVerdict = undefined | null
  | { action: 'allow'; bypass?: string[] }
  | { action: 'deny'; reason?: string }
  /** `recipient`: who receives it, as the owner knows them (a person's name); the card names it (#418). */
  | { action: 'hold'; reason?: string; recipient?: string }

export interface SendMiddleware {
  /** e.g. 'social', 'tree'. */
  name: string
  /**
   * Lower runs first; default `SendPriority.DEFAULT` (500). Bands: ROUTING 100 (e.g. tree
   * relays), DEFAULT 500 (policies), APPROVAL 900 (holds and transports, e.g. social).
   * Prefer this over naming other plugins in before/after.
   */
  priority?: number
  /** Run before / after these middleware names (kept for compatibility; wins over priority). */
  before?: string[]
  after?: string[]
  handle(msg: SendMessage): SendVerdict | Promise<SendVerdict>
}

export interface SendPriority { readonly ROUTING: 100; readonly DEFAULT: 500; readonly APPROVAL: 900 }

export type SendResult =
  | { action: 'allow'; exchangeId: string }
  | { action: 'hold'; approvalId: string; reason: string; by: string }
  | { action: 'deny'; reason: string; by: string }

export interface Approval {
  id: string
  status: 'pending' | 'approved' | 'rejected' | 'denied' | 'failed' | 'stale'
  reason: string
  /** Middleware that held it. */
  by: string
  /** Who receives it, as the holding middleware named them (#418). */
  recipientName?: string
  createdAt: number
  decidedAt?: number
  note?: string
  error?: string
  exchangeId?: string
  /** The held send's own exchange id (#52). */
  requestId?: string
  /** sha256 over the request content; a changed request is stale, never dispatched (#52). */
  version?: string
  /** Server-derived: the sender Bot's owner, who alone may decide (#52). */
  ownerId?: string
  /** Where the request came from: which plugin relayed it and how many hops (#52). */
  origin?: { via: string; hop: number; audience?: string }
  request: SendMessage
  /** List-view context, resolved server-side: sender and target names (#52). */
  senderName?: string
  targetName?: string
}

export interface Transport {
  /**
   * Delivers a message whose `to` is a RemoteBotRef with this transport. `approved` is true when the
   * owner approved this very send on a FlyBot approval card (set by the host, never by the sender).
   */
  send(msg: SendMessage & { approved?: boolean }): Promise<{ exchangeId?: string } | void>
}

export interface FlyBotTool {
  name: string
  description: string
  /** DSH defineTool parameter map, e.g. { name: { type: 'string', required: true } }. */
  parameters: Record<string, unknown>
  /** Synchronous. Default: every Bot on the team (plain Sessions never). */
  visibleTo?(botId: BotId): boolean
  /** Non-string results are JSON-encoded. */
  execute(args: any, exec: { botId: BotId; agent?: { id: string }; [key: string]: unknown }): unknown | Promise<unknown>
}

export interface FlyBot {
  version: 1
  /** Plugin this handle is scoped to; 'shared' for the unscoped service. */
  plugin: string
  /** The same API with fields/events/sends attributed to `plugin`. */
  scope(plugin: string): FlyBot
  /** Resolves once ds-bot has loaded its saved team (bot.list() is complete). */
  ready(): Promise<void>
  /** True while another dsh holds the team: no polling, no writes. */
  readOnly(): boolean
  on: On
  /** Writes a warning to the host diagnostics log (Settings → Feedback). */
  warn(template: string, ...args: unknown[]): void
  fields: BotFields
  bot: {
    get(id: BotId): BotView | undefined
    list(): BotView[]
    find(name: string): BotView | undefined
    /** True for a remote address ({ kind: 'remote' } or '@handle'); local ids are never remote. */
    isRemote(ref: unknown): boolean
    /** True when this Bot has a grant matching `peer` (or any person-grant when omitted). */
    hasGrant(id: BotId, peer?: BotRef, roomId?: string): boolean
    /** True when this Bot has at least one person-grant. */
    hasAnyGrant(id: BotId): boolean
    /** The Bot a Session (own chat, group, or earlier part) belongs to. */
    of(sessionId: string): BotView | undefined
    /** Returns the new Bot's id. */
    create(spec: CreateBotSpec): Promise<BotId>
    setSystemPrompt(id: BotId, text: string): void
    /** Same object as FlyBot.fields. */
    fields: BotFields
    send: ((req: SendRequest) => Promise<SendResult>) & {
      use(middleware: SendMiddleware): () => void
      list(): { name: string; priority: number; before: string[]; after: string[] }[]
      /** The priority bands (since 0.1.5-flybot.1). */
      priority: SendPriority
    }
  }
  transports: { add(kind: string, transport: Transport): () => void }
  /** Outgoing grants for a local Bot (one Bot → one grantee; optional room scope). */
  grants: {
    of(botId: BotId): Array<{ id: string; grantee: string; name?: string; relationshipId?: string; roomId?: string }>
    has(botId: BotId, peer?: BotRef, roomId?: string): boolean
    set(botId: BotId, list: Array<{ id?: string; grantee: string; name?: string; relationshipId?: string; roomId?: string }>): Promise<unknown>
  }
  /** Friends' remote Bots shown as chat members (remote badge, "@handle" mentions). Not team Bots. */
  remote: {
    /** Replaces this plugin's granted-remote list. */
    publish(list: Array<{ handle: string; name?: string; home?: string; homeName?: string; owner?: string }>): void
    list(): RemoteMember[]
    get(handle: string): RemoteMember | undefined
  }
  /** Optional: pending Bot Social approvals for a shared room the invited owner is viewing. */
  roomApprovals: {
    setProvider(fn: ((room: { id?: string; participants?: unknown[]; sharedFrom?: unknown; viewerRole?: string; origin?: string; face?: { roomId?: string } }, actor?: { memberId?: string }) => unknown[]) | undefined): void
  }
  /** Optional: pending Bot Social approvals for a 1:1 friend's-Bot chat. */
  chatApprovals: {
    setProvider(fn: ((bot: { id?: string; remote?: { handle?: string } }, actor?: { memberId?: string }) => unknown[]) | undefined): void
    /** The provider's list changed (a hold arrived or was decided): the sidebar badge refreshes now. */
    changed(): void
  }
  /** Face-to-face rooms (#83): host a Bot Social matching room as a normal native room. */
  rooms: {
    /** Every hosted room (native, shared, face-to-face). Used to hide a friend's Bot from groups. */
    list(): Array<{
      id: string
      name?: string
      origin?: string
      face?: { roomId?: string }
      members?: string[]
      participants?: Array<{ kind?: string; id?: string; handle?: string; remote?: boolean; leftSeq?: number }>
    }>
    removeParticipant(roomId: string, ref: { kind?: string; id?: string; handle?: string; remote?: boolean }): Promise<unknown>
    upsertFace(spec: {
      roomId: string
      name?: string
      status?: string
      expiresAt?: string | null
      startedAt?: string | null
      eventCursor?: number
      members?: Array<{ handle?: string; displayName?: string; ownerName?: string; roomOnly?: boolean; published?: boolean; id?: string }>
      localBots?: Array<{ id: string; handle?: string; name?: string }>
      localId?: string
    }): Promise<{ id: string; face?: { roomId?: string } } | undefined>
    applyFaceLine(roomId: string, line: Record<string, unknown>): unknown
    ofFace(serverId: string): { id: string; face?: { roomId?: string; eventCursor?: number } } | undefined
    dropFace(roomId: string): Promise<boolean | undefined>
    onFaceLine(fn: ((room: { id: string; face?: { roomId?: string }; members?: string[] }, line: Record<string, unknown>) => unknown) | undefined): () => void
    postNotice(roomId: string, text: string): unknown
    postRemote(roomId: string, msg: { handle?: string; name?: string; text?: string }): unknown
    /** Inbox envelope → inbound-share room (join/line/leave). */
    applyInbound?(event: {
      fromHandle?: string
      fromHome?: string
      fromName?: string
      text?: string
      localBotId?: string
      ownerId?: string
    }, actor?: { memberId?: string }): Promise<{ handled: boolean; room?: { id: string; origin?: string } } | undefined>
    /** Hide inbound-share rooms when the invited Bot is removed or its grant is revoked. */
    leaveInbound?(spec: { localBotId?: string; handle?: string; grantee?: string }): Promise<void>
  }
  approvals: {
    list(filter?: { status?: Approval['status'] | 'all' }): Approval[]
    get(id: string): Approval | undefined
    /** Owner only: exposed to the UI route, never as a model tool. */
    decide(id: string, decision: 'approve' | 'reject', options?: { note?: string }): Promise<Approval>
    /** 'retry' re-sends a failed approval; an approve resumes the chain after the holder. */
    onChange(listener: (approval: Approval) => void): () => void
  }
  tools: { register(tool: FlyBotTool): () => void }
  api: {
    /** UI endpoint: POST api/bot { endpoint: 'flybot/<name>', payload }. */
    /** `read: true` marks a query a read-only host (another dsh holds the team) still serves. */
    handle(name: string, fn: (payload: any) => unknown | Promise<unknown>, options?: { read?: boolean }): () => void
  }
  outcomeOf(exchangeId: string): SendResult | undefined
}

export interface FlyBotConfig {
  flybot?: {
    /** middleware name -> names it may bypass, e.g. { tree: ['social'] }. Default: none. */
    bypass?: Record<string, string[]>
  }
}

// ---------------------------------------------------------------- browser

export interface SidebarSectionProps { roster: any; actions: any; call: FlyBotCall }
export interface BotDetailsProps { bot: any; roster: any; call: FlyBotCall }
export interface ApprovalCardProps { approval: Approval; decide(decision: 'approve' | 'reject'): Promise<void>; call: FlyBotCall }
export interface MentionRow { name: string; value: string; description?: string; icon?: string; section?: string }
export type FlyBotCall = (endpoint: string, payload?: unknown) => Promise<any>

/**
 * Browser side of the FlyBot API (src/client/flybot-registry.js, flybot-slots.js).
 *
 * How a client plugin gets it: a DSH web client bundle (`window.__ModuleLoader__.load({ id,
 * inject: ['flybot'], ... })`, see plugins/tree/client.js) receives the browser service as
 * `ctx.flybot` (a {@link FlyBotClient}). The same registry is also on `globalThis.__flybot__`
 * for code without a Cordis context (`BotAvatar` / `BotMark` / `lookOf` are the host Bot
 * look, set when the client registry() runs). Slots below are FlyBot's own registry: register them
 * with `ctx.flybot.slots.register(name, entry)`, NOT the shell's `ctx.slots` (which throws
 * `slot "flybot.…" is not declared`). Every `register` returns a disposer; call it from
 * `ctx.effect` so a reload or uninstall removes the entry. Entries are sorted by `order`
 * (lower first, default 0), each slot entry renders inside its own error boundary, and a
 * failing plugin only hides its own entries. Styling may use the documented `--bt-*` CSS
 * custom properties (ink, hover, line, accent); other ds-bot class names are internal.
 *
 * - `flybot.sidebar.section`: a block in the left sidebar under the Bot list.
 * - `flybot.sidebar.structure`: turns the sidebar Bot list into a tree (`parentOf`); also
 *   adds right-click items (`menuItems`) and per-node actions. First registered entry wins.
 * - `flybot.composer.mention`: extra rows in the composer's @-menu (e.g. friends' Bots).
 * - `flybot.bot.details`: a section in a Bot's details panel.
 * - `flybot.approvals`: renders held sends (approval cards), optionally only those held by
 *   one middleware (`policy`).
 * - `flybot.room.overview`: a block at the top of a group's overview (Leave / Start for a
 *   face-to-face room).
 * - `flybot.session.dock`: a card above the composer in a Bot or group chat (held Bot
 *   Social replies waiting for approval).
 * - `flybot.account.header`: a compact block at the top of the account menu (the social
 *   plugin shows the owner's own Bot Social handle with a copy button).
 * - `flybot.settings.page`: a page in the Settings list, after Connectors. `label` is an English
 *   key looked up with the host `t()`; the component receives the host `t`, `Section(title)` and
 *   `Row(label, hint)` so it matches the other pages and reads in the DSH language.
 * - `flybot.new-chat.action`: a row in the sidebar '+' new-chat menu, after
 *   New group chat (e.g. Face-to-face room, Add friend). `label` / `hint` are English keys
 *   looked up with the same `t()` map as the neighbouring rows; every row has a short one-line
 *   `hint` with no closing period, and its own `icon` (a React component; default: people).
 */
export interface FlyBotSlots {
  'flybot.sidebar.section': { id: string; order?: number; component(props: SidebarSectionProps): any }
  /** The sidebar Bot list as one tree under the Main Bot; a missing/unknown parent means "under the Main Bot". First entry wins. */
  'flybot.sidebar.structure': {
    id: string; order?: number; parentOf(botId: string): string | null | undefined
    /** Extra items in a Bot's right-click menu. visible false hides one; a string returned by run is shown as a toast, a throw as the error toast. */
    menuItems?(props: { bot: { id: string; name: string } }): Array<{ id: string; label: string; visible?: boolean; run(props: { bot: { id: string; name: string } }): unknown }>
    nodeActions?: unknown
  }
  'flybot.composer.mention': { id: string; order?: number; candidates(query: string, context: { sessionId: string; roster: any; call: FlyBotCall }): MentionRow[] | Promise<MentionRow[]> }
  'flybot.bot.details': { id: string; order?: number; component(props: BotDetailsProps): any }
  /** policy: only approvals held by this middleware name; omit for all. */
  'flybot.approvals': { id: string; order?: number; policy?: string; component(props: ApprovalCardProps): any }
  'flybot.room.overview': { id: string; order?: number; component(props: { room: any; roster: any; actions: any; call: FlyBotCall }): any }
  'flybot.session.dock': { id: string; order?: number; /** The `by` of the approvals this dock draws; the overlay then draws no second card for the ids it claims. */ policy?: string; component(props: { sessionId?: string; roster?: any; room?: any; bot?: any; actions?: any; call: FlyBotCall; /** Report the approval ids this dock shows (a plugin's own policy). */ claim?: (ids: string[]) => void }): any }
  'flybot.account.header': { id: string; order?: number; component(props: { actions?: any; call: FlyBotCall }): any }
  'flybot.settings.page': {
    id: string
    order?: number
    label: string
    /** A React component drawn beside the label in the Settings list (default: the connector mark). */
    icon?: any
    component(props: { roster: any; actions: any; call: FlyBotCall; run(promise: Promise<unknown>): Promise<boolean>; t(key: string, params?: Record<string, unknown>): string; Section: any; Row: any }): any
  }
  'flybot.new-chat.action': {
    id: string
    order?: number
    label: string
    hint?: string
    /** A React component drawn as the row's mark (default: the people mark). */
    icon?: any
    visible?(context: { mode?: string; group?: boolean; picked?: string[]; query?: string; roster?: any }): boolean
    run(context: { close?: () => void; actions?: any; roster?: any }): void
  }
}

/** Browser ctx.flybot (client plugins inject 'flybot'). */
export interface FlyBotClient {
  /** Team Bots, each with fields: { [plugin]: {...} } (read-only snapshot from the host). */
  bots(): Promise<BotView[]>
  /** Field changes pushed from the host; returns an unsubscribe function. */
  fields: { on(event: 'change', listener: (change: FieldChange) => void): () => void }
  /** FlyBot's slot registry (see {@link FlyBotSlots}). */
  slots: FlyBotClientRegistry
  /** Calls a host endpoint registered with `flybot.api.handle` (e.g. 'social/friends'). */
  call: FlyBotCall
}

export interface FlyBotClientRegistry {
  register<K extends keyof FlyBotSlots>(name: K, entry: FlyBotSlots[K]): () => void
  entries<K extends keyof FlyBotSlots>(name: K): FlyBotSlots[K][]
  subscribe(listener: () => void): () => void
}

/** Host Bot look: same component the sidebar / session list / chat header render. */
export type FlyBotBotMark = (props: { bot?: any; look?: { shape?: string; color?: string; image?: string; emoji?: string }; size?: number; [key: string]: unknown }) => any
export type FlyBotBotAvatar = (props: { bot?: any; size?: number; badge?: boolean; live?: boolean; [key: string]: unknown }) => any
export type FlyBotLookOf = (bot?: any) => { shape: string; color: string; image?: string }

declare global {
  // eslint-disable-next-line no-var
  var __flybot__: {
    slots: FlyBotClientRegistry
    call?: FlyBotCall
    api?: FlyBotClient
    /** Same character mark as the sidebar / chat header. Set by the host client registry(). */
    BotMark?: FlyBotBotMark
    /** Sidebar avatar (mark plus optional badges). Prefer this at 24px with badge: false. */
    BotAvatar?: FlyBotBotAvatar
    lookOf?: FlyBotLookOf
  } | undefined
}

declare module 'cordis' {
  interface Context {
    flybot: FlyBot
  }
}

export interface RemoteMember { handle: string; home: string; name: string; homeName?: string; owner?: string; plugin: string; remote: true }

/** A file a send carries: a local path (outbound) or a remote id (inbound). */
export interface FileAttachment {
  name: string
  size: number
  mime: string
  /** Hex SHA-256 of the bytes, checked again before upload and after download. */
  sha256?: string
  /** Outbound: local file read by the transport after approval. Never shown to a remote side. */
  path?: string
  /** Inbound: the remote service's attachment id. */
  id?: string
}
