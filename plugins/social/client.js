// flybot-social browser half: plain JS, loaded by DSH as a classic script. Registers
// into the FlyBot slot registry that ds-bot's client renders (src/client/flybot-slots.js).
window.__ModuleLoader__.load({
  id: '@flybot/social',
  factory(require) {
    const { createElement: h, useEffect, useState, useRef } = require('react')
    const slots = () => {
      // Same bootstrap as ds-bot's flybot-registry.js: whichever bundle loads first creates it.
      if (globalThis.__flybot__ === undefined) throw new Error('flybot-social needs ds-bot with FlyBot slots')
      return globalThis.__flybot__.slots
    }
    const call = (endpoint, payload) => globalThis.__flybot__.call(endpoint, payload)

    // Errors in English. ds-bot's api.js may localize transport errors ("HTTP 404" becomes
    // Chinese in a zh UI), so the panel words them from the error code instead.
    const isSocialMissing = (e) => {
      const code = String(e?.code ?? '')
      const message = String(e?.message ?? e ?? '')
      return code === 'bot/not-found' || /Unknown FlyBot endpoint social\//i.test(message)
    }
    const errorText = (e) => {
      const code = String(e?.code ?? '')
      const http = code.match(/^HTTP_(\d+)$/)
      if (http) return `The FlyBot host did not answer (HTTP ${http[1]}). Reload the page; if this keeps happening, restart FlyBot web.`
      if (code === 'NETWORK') return 'Could not reach FlyBot. Check that it is still running.'
      if (isSocialMissing(e)) {
        return 'Social is not running: the plugin did not start. See Settings → Feedback.'
      }
      const message = String(e?.message ?? e ?? '')
      if (/relationship_exists/i.test(message)) return "You're already friends. Their Bot is back in your list."
      // Only the raw server words map here. The "invite wasn't found" sentence also says "already used" (as one of its possible
      // causes), so matching those words would relabel every unknown or mistyped link as a used one.
      if (/invite_unavailable|invite is used|invite_used/i.test(message)) return 'This invite was already used. Ask your friend for a new one.'
      return message
    }

    // Styles reuse ds-bot's sidebar tokens (--bt-ink, --bt-ink-2, --bt-ink-3, --bt-hover, --bt-line,
    // --bt-line-2, --bt-card, --bt-accent, --bt-tag-bg/-ink), like @flybot/tree, so both themes follow the app.
    const CSS = `
.fs{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--bt-ink,#141414);padding:0 4px 6px;overflow:hidden;box-sizing:border-box;max-width:100%}
.fs *,.fs *::before,.fs *::after{box-sizing:border-box}
.fs-head{display:flex;align-items:center;gap:4px;padding:0 0 0 0}
.fs-head-main{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-2,rgba(20,20,20,.6));font:inherit;font-size:12px;line-height:16px;font-weight:500;text-align:left;cursor:pointer;transition:background-color .12s ease}
.fs-head-main:hover,.fs-icon:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-chev{display:inline-flex;width:12px;justify-content:center;color:var(--bt-ink-3,rgba(20,20,20,.36));transition:transform .12s ease}
.fs-head-main[aria-expanded=false] .fs-chev{transform:rotate(-90deg)}
.fs-title{flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fs-count,.fs-tag{flex:none;font-size:11px;line-height:14px;padding:1px 6px;border-radius:4px;background:var(--bt-tag-bg,rgba(20,20,20,.06));color:var(--bt-tag-ink,rgba(20,20,20,.56));font-weight:500}
.fs-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-2,rgba(20,20,20,.6));font:inherit;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap}
.fs-icon[aria-expanded=true]{background:var(--bt-active,rgba(119,119,119,.17));color:var(--bt-ink,#141414)}
.fs-body{display:flex;flex-direction:column;gap:2px;padding:2px 0 0}
.fs-empty,.fs-hint{padding:4px 10px;font-size:12px;line-height:17px;color:var(--bt-ink-2,rgba(20,20,20,.6));overflow-wrap:anywhere}
.fs-join-as{align-items:baseline;flex-wrap:wrap;overflow-wrap:normal;word-break:normal}
.fs-join-as-label{flex:none;white-space:nowrap;overflow-wrap:normal;word-break:keep-all}
.fs-empty{padding:6px 10px 8px;font-size:13px;line-height:18px}
.fs-label{padding:8px 10px 2px;font-size:11px;line-height:14px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--bt-ink-3,rgba(20,20,20,.36));display:flex;align-items:center;gap:6px}
.fs-home-head{display:flex;align-items:center;gap:4px;min-width:0;padding:2px 4px 0 0}
.fs-home{display:flex;align-items:baseline;gap:6px;flex:1 1 auto;min-width:0;padding:4px 8px;border:0;border-radius:8px;background:transparent;font:inherit;font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-2,rgba(20,20,20,.6));text-align:left;cursor:pointer}
.fs-home:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-home .fs-chev[data-closed]{transform:rotate(-90deg)}
.fs-home-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.fs-home-handle{font-weight:400;color:var(--bt-ink-3,rgba(20,20,20,.36));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.fs-auto{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:14px;color:var(--bt-ink-3,rgba(20,20,20,.36));cursor:pointer;white-space:nowrap}
.fs-auto input{margin:0;accent-color:var(--bt-accent,#4d6bfe)}
.bt-social-rows{display:flex;flex-direction:column}
.fs-row{display:flex;align-items:center;gap:8px;min-width:0;padding:5px 8px 5px 10px;border-radius:8px;transition:background-color .12s ease}
.fs-row:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--bt-tag-bg,rgba(20,20,20,.06));color:var(--bt-ink-2,rgba(20,20,20,.6));font-size:12px;font-weight:600;overflow:hidden}
.fs-avatar img{width:100%;height:100%;object-fit:cover;display:block}
.fs-face-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:var(--fs-face-size,24px);height:var(--fs-face-size,24px)}
.fs-face-mark .bt-mark,.fs-face-mark .fs-avatar{width:100%;height:100%;font-size:calc(var(--fs-face-size,24px)*.5)}
.fs-text{display:flex;flex-direction:column;flex:1 1 auto;min-width:0}
.fs-name{font-size:14px;line-height:19px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fs-sub{font-size:12px;line-height:16px;color:var(--bt-ink-2,rgba(20,20,20,.6));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fs-msg{white-space:normal;overflow-wrap:anywhere}
.fs-actions{flex:none;display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;max-width:100%}
.fs-card{margin:4px 4px 2px;padding:10px;border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:10px;background:var(--bt-card,#fff);display:flex;flex-direction:column;gap:8px}
.fs-friend-settings{display:flex;flex-direction:column;gap:14px;max-width:280px}
.fs-friend-auto{margin:0}
.fs-friend-remove{display:flex;padding:0 4px}
.fs-friend-settings .fs-auto{align-self:flex-start;max-width:100%;min-width:0;white-space:normal;overflow-wrap:anywhere;font-size:12px;line-height:16px;color:var(--bt-ink-2,rgba(20,20,20,.6))}
.fs-friend-settings .fs-auto input{flex:none;width:14px;height:14px}
.fs-friend-settings .fs-leave-ask{flex-wrap:wrap;white-space:normal}
.fs-friend-settings .fs-link{align-self:flex-start;color:var(--bt-ink-3,rgba(20,20,20,.36))}
.fs-friend-remove .fs-leave-ask{display:flex;align-items:center;gap:6px}
.fs-card .fs-hint{padding:0}
.fs-line{display:flex;gap:6px;min-width:0;align-items:center}
.fs-input{flex:1 1 auto;min-width:0;width:0;height:30px;padding:0 9px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;outline:none;text-overflow:ellipsis}
.fs-input:focus{border-color:var(--bt-accent,#4d6bfe)}
.fs-input[readonly]{background:var(--bt-tag-bg,rgba(20,20,20,.06));border-color:transparent}
.fs-btn{flex:none;height:30px;padding:0 12px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:8px;background:transparent;color:var(--bt-ink,#141414);font:inherit;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color .12s ease}
.fs-btn:hover:not(:disabled){background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-btn:disabled{opacity:.45;cursor:default}
.fs-btn-primary{border-color:transparent;background:var(--bt-accent,#4d6bfe);color:#fff;width:100%}
.fs-btn-primary:hover:not(:disabled){background:var(--bt-accent,#4d6bfe);filter:brightness(1.08)}
.fs-btn-sm{height:26px;padding:0 9px;font-size:12px}
.fs-link{padding:0;border:0;background:none;color:var(--bt-accent,#4d6bfe);font:inherit;font-size:12px;cursor:pointer}
.fs-link:hover{text-decoration:underline}
.fs-status{padding:0;font-size:12px;line-height:17px;color:var(--bt-ink-2,rgba(20,20,20,.6));overflow-wrap:anywhere}
.fs-status[data-tone=error]{color:#e5484d}
.fs-pending-tag{background:var(--bt-accent,#4d6bfe);color:#fff}
.fs-refresh{flex:none;font-size:11px;line-height:14px;color:var(--bt-ink-3,rgba(20,20,20,.36));font-weight:400}
.fs-thinking{margin:0 12px 6px;padding-inline-start:8px;font-size:13px;line-height:20px;min-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-room-end{margin:6px 12px;padding:8px 10px;border-radius:8px;background:var(--bt-hover,rgba(119,119,119,.09));color:var(--bt-ink-2,rgba(20,20,20,.6));font-size:12px;line-height:16px}
/* A left or closed face room is read-only (#197): its end line replaces the composer. */
[class*="_composerStack"]:has([data-flybot="face-room-end"]) [class*="_root"]:has(> [data-composer-card]){display:none!important}
.fs-me{display:flex;align-items:center;gap:6px;padding:0 10px 4px;justify-content:space-between;font-size:11px;line-height:14px;color:var(--bt-ink-3,rgba(20,20,20,.36))}
.fs-me-handle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink,#141414);font-size:13px}
.bt-menu .fs-me button.fs-link{display:inline;flex:none;width:auto;min-height:0;padding:0 2px;border-radius:4px;font-size:12px;line-height:16px}
.fs-me .fs-link{flex:none}
.fs-pending{margin:4px 4px 6px;padding:6px 8px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:10px;background:var(--bt-card,#fff);display:flex;flex-direction:column;gap:4px;min-width:0;max-width:100%}
.fs-pending .fs-label{padding:0}
.fs-pending-item{display:flex;align-items:center;gap:8px;width:100%;max-width:100%;min-width:0;padding:4px 4px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;flex-wrap:nowrap}
.fs-pending-item:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-pending-item .fs-text{min-width:0;flex:1 1 auto;overflow:hidden;display:flex;flex-direction:row;align-items:baseline;gap:8px}
.fs-pending-item .fs-name{flex:0 1 auto;max-width:40%;min-width:0}
.fs-pending-one{flex:1 1 auto;font-size:12px;line-height:16px;color:var(--bt-ink-2,rgba(20,20,20,.6));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.fs-draft{font-size:13px;line-height:18px;color:var(--bt-ink,#141414);white-space:pre-wrap;overflow-wrap:anywhere;max-height:96px;overflow:auto}
.fs-digits{flex:1 1 auto;min-width:0;width:0;height:30px;padding:0 9px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:16px;letter-spacing:.24em;font-variant-numeric:tabular-nums;outline:none;text-align:center}
.fs-digits::placeholder{color:var(--bt-ink-3,rgba(20,20,20,.36));opacity:.75;font-weight:400;font-size:13px;letter-spacing:normal}
.fs-digits:focus{border-color:var(--bt-accent,#4d6bfe)}
.fs-sharing{display:flex;flex-direction:column;gap:10px}
.fs-label-plain{text-transform:none;letter-spacing:0;font-size:13px;line-height:18px;font-weight:600;color:var(--bt-ink,#141414)}
.fs-invite-link{width:100%;box-sizing:border-box;min-width:0}
.fs-invite-actions{flex-wrap:wrap}
.fs-btn-fit{width:auto}
.fs-invite-new{margin-left:auto}
.fs-sharing > .fs-label{padding:0 4px;text-transform:none;letter-spacing:0;font-size:13px;line-height:18px;font-weight:600;color:var(--bt-ink,#141414)}
.fs-face{margin:4px 4px 6px;padding:8px 10px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:10px;background:var(--bt-card,#fff);display:flex;flex-direction:column;gap:6px;min-width:0}
.fs-face-item{display:flex;flex-direction:column;gap:2px;min-width:0;width:100%;overflow:hidden}
.fs-face-row{display:flex;align-items:center;gap:6px;min-width:0;width:100%;padding:2px 0;flex-wrap:nowrap;overflow:hidden}
.fs-face-row .fs-name{flex:1 1 0;min-width:0}
.fs-face-row[data-open]{cursor:pointer}
.fs-face-actions{display:flex;gap:4px;flex:none;flex-wrap:nowrap}
.fs-face-actions .fs-btn-sm{height:22px;padding:0 6px;font-size:11px}
.fs-stack{display:flex;flex-direction:row;align-items:center;flex:none}
.fs-stack .fs-face-mark,.fs-stack [data-flybot=face-card-member]{margin-left:-6px}
.fs-stack .fs-face-mark:first-child,.fs-stack [data-flybot=face-card-member]:first-child{margin-left:0}
.fs-stack [data-flybot=face-card-member]{display:inline-flex;border-radius:50%;box-shadow:0 0 0 2px var(--bt-card,#fff)}
.fs-stack-more{flex:none;font-size:11px;line-height:14px;color:var(--bt-ink-3,rgba(20,20,20,.36));margin-left:4px}
.fs-srv-form{display:flex;flex-direction:column;gap:8px;padding:10px 12px}
.fs-srv-quick{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}
.fs-srv-checked{display:flex;flex-direction:column;gap:2px}
.fs-srv-warn{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px;background:var(--bt-hover,rgba(119,119,119,.09));font-size:12px;line-height:17px;color:var(--bt-ink-2,rgba(20,20,20,.6))}
.fs-srv-warn strong{color:var(--bt-ink,#141414);font-size:13px}
.fs-srv-actions{display:flex;gap:6px;justify-content:flex-end}
.fs-chip{flex:none;font-size:11px;line-height:14px;padding:1px 6px;border-radius:4px;background:var(--bt-tag-bg,rgba(20,20,20,.06));color:var(--bt-tag-ink,rgba(20,20,20,.56));white-space:nowrap}
.fs-chip-status{min-width:44px;text-align:center;font-weight:600;letter-spacing:.01em}
.fs-chip-status[data-status=open],.fs-chip-status[data-status=closed],.fs-chip-status[data-status=left]{font-size:12px;line-height:16px;padding:2px 8px;color:var(--bt-ink-2,rgba(20,20,20,.72));background:var(--bt-hover,rgba(119,119,119,.12))}
.fs-face-item[data-past] .fs-face-row{gap:8px}
.fs-face-item[data-past] .fs-chip-status{margin-left:4px}
.fs-face-item[data-past] .fs-face-actions{margin-left:8px;gap:6px}
.fs-face-head{display:flex;flex-direction:column;align-items:stretch;gap:8px;width:100%;padding:2px 0 6px}
.fs-face-top{display:flex;align-items:center;gap:10px;min-width:0}
.fs-face-head .fs-face-auto-wrap{min-width:0}
.fs-face-head .fs-face-actions{flex:none;margin-left:auto}
.fs-leave-ask{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.fs-past{margin:2px 0 4px}
.fs-past-head{display:flex;align-items:center;gap:6px;width:100%;padding:4px 8px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-3,rgba(20,20,20,.36));font:inherit;font-size:12px;line-height:16px;font-weight:500;text-align:left;cursor:pointer}
.fs-past-head:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-past-head .fs-chev[data-closed]{transform:rotate(-90deg)}
.fs-face-auto-wrap{display:inline-flex;align-items:center;gap:2px;padding:0}
.fs-face-auto{white-space:nowrap;font-size:11px;line-height:14px;color:var(--bt-ink-3,rgba(20,20,20,.36))}
.fs-face-note{padding:0;display:none}
.fs-chat-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
[data-flybot=chat-approvals]{display:flex;flex-direction:column;align-items:flex-end;gap:8px;width:100%;box-sizing:border-box;padding:0 0 4px}
.fs-hold{box-sizing:border-box;width:100%;max-width:min(460px,100%);min-width:0;margin:0 0 0 auto;padding:10px 12px;border:.5px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:14px;background:var(--bt-card,#fff);color:var(--bt-ink,#141414);display:flex;flex-direction:column;gap:6px;box-shadow:0 1px 2px rgba(20,20,20,.06);overflow:hidden}
.fs-hold .fs-label{padding:0;font-size:11px;line-height:14px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--bt-ink-3,rgba(20,20,20,.36))}
.fs-hold .fs-sub{font-size:13px;line-height:18px;font-weight:500;color:var(--bt-ink,#141414);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fs-hold .fs-draft{margin:0;font-size:13px;line-height:18px;color:var(--bt-ink-2,rgba(20,20,20,.6));overflow-wrap:break-word;word-break:normal;white-space:pre-wrap;max-height:none}
.fs-hold .fs-draft[data-clamp]{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;white-space:normal;overflow-wrap:break-word;word-break:normal;max-height:calc(18px * 3)}
.fs-hold-more{align-self:flex-start;margin:0;padding:0;border:0;background:none;color:var(--bt-accent,#4d6bfe);font:inherit;font-size:12px;line-height:16px;cursor:pointer}
.fs-hold-more:hover{text-decoration:underline}
.fs-hold .fs-actions{margin-top:2px;justify-content:flex-end;gap:6px 8px;flex-wrap:wrap}
.fs-hold .fs-btn{flex:none;height:28px;padding:0 12px;border-radius:999px;font-size:12px}
.fs-hold .fs-btn-primary{width:auto;color:#fff}
.fs-hold .fs-hold-decide{display:flex;gap:8px;flex:none}
.fs-hold .fs-actions .fs-hold-always{order:-1;margin-right:auto;white-space:nowrap;flex:0 0 auto}
.fs-hold[data-state] .fs-name{font-size:13px;line-height:18px;font-weight:500;color:var(--bt-ink-2,rgba(20,20,20,.6))}
.fs-row-wrap{position:relative;display:flex;align-items:center;gap:2px;min-width:0}
.fs-row-wrap .fs-row,.fs-row-wrap > :first-child{flex:1 1 auto;min-width:0}
.fs-remove{flex:none;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--bt-ink-3,rgba(20,20,20,.36));font:inherit;font-size:14px;line-height:1;cursor:pointer;opacity:0}
.fs-row-wrap:hover .fs-remove,.fs-row-wrap:focus-within .fs-remove,.fs-remove:focus-visible,.fs-remove:disabled{opacity:1}
.fs-remove:hover:not(:disabled),.fs-remove:focus-visible{background:var(--bt-hover,rgba(119,119,119,.09));color:var(--bt-ink,#141414)}
.fs-remove:disabled{cursor:default;opacity:.55}
.fs-menu{position:absolute;right:4px;top:100%;z-index:5;min-width:160px;padding:4px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:8px;background:var(--bt-card,#fff);box-shadow:0 4px 16px rgba(0,0,0,.12)}
.fs-menu button{display:block;width:100%;text-align:left;height:28px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}
.fs-menu button:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-chat-approval{margin:0;min-width:0}
.fs-chat-approval[data-state=approved] .fs-label,.fs-chat-approval[data-state=rejected] .fs-label,.fs-chat-approval[data-state=approved] .fs-name,.fs-chat-approval[data-state=rejected] .fs-name{color:var(--bt-ink-2,rgba(20,20,20,.6))}
.fs-dialog-back{position:fixed;inset:0;z-index:62;background:rgba(20,20,20,.4);display:flex;align-items:center;justify-content:center;padding:12px}
.fs-dialog{width:min(420px,100%);max-height:min(640px,92vh);overflow:hidden;margin:0;padding:14px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:14px;background:var(--bt-card,#fff);display:flex;flex-direction:column;gap:10px;box-shadow:0 12px 40px rgba(0,0,0,.18)}
.fs-dialog-head{display:flex;align-items:center;gap:8px;flex:none}
.fs-dialog-head .fs-name{flex:1 1 auto}
.fs-dialog > form{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px}
.fs-tiles{margin:0;padding:4px 0 0;list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:10px 6px;align-content:start}
.fs-pick{max-height:220px;overflow:auto}
.fs-tile{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;padding:6px 2px;border-radius:10px}
.fs-tile-hit{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;width:100%;margin:0;cursor:pointer;font:inherit;position:relative}
.fs-tile-hit:hover,.fs-tile-on{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-tile-mark{position:relative;flex:none;display:inline-flex}
.fs-tile-name{display:block;width:100%;font-size:12px;line-height:16px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--bt-ink,#141414)}
.fs-tile-sub{display:block;width:100%;font-size:11px;line-height:14px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--bt-ink-2,rgba(20,20,20,.6))}
.fs-wait-overview{margin:0 0 8px;padding:8px 10px;border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:12px;background:var(--bt-card,#fff);display:flex;flex-direction:column;gap:8px;min-width:0;max-width:100%}
.fs-wait-overview .fs-wait-foot{margin-top:2px}
.fs-tile-mine{position:absolute;right:-1px;bottom:-1px;width:8px;height:8px;border-radius:50%;background:var(--bt-accent,#4d6bfe);box-shadow:0 0 0 2px var(--bt-card,#fff);pointer-events:none}
.fs-tile-on .fs-face-mark{border-radius:50%;box-shadow:0 0 0 2px var(--bt-accent,#4d6bfe)}
.fs-tile-check{position:absolute;right:-2px;bottom:-2px;width:16px;height:16px;border-radius:50%;background:var(--bt-accent,#4d6bfe);color:#fff;font-size:11px;line-height:16px;text-align:center;pointer-events:none;box-shadow:0 0 0 2px var(--bt-card,#fff)}
.fs-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.fs-wait{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;overflow:hidden}
.fs-wait-count{flex:none;padding:0}
.fs-wait-code{flex:none;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 0 2px}
.fs-wait-code-label{font-size:11px;line-height:14px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--bt-ink-3,rgba(20,20,20,.36))}
.fs-wait-code-digits{font-size:28px;line-height:34px;font-weight:600;letter-spacing:.28em;font-variant-numeric:tabular-nums;color:var(--bt-ink,#141414)}
.fs-wait-body{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:4px}
.fs-wait-foot{display:flex;align-items:stretch;gap:8px;flex:none}
.fs-wait-foot .fs-btn{height:36px}
.fs-wait-foot .fs-btn-primary{flex:1 1 auto;width:auto;min-width:0}
.fs-fail{padding:0}
`
    function useStyles() {
      useEffect(() => {
        if (typeof document === 'undefined' || document.getElementById('flybot-social-css')) return
        const style = document.createElement('style')
        style.id = 'flybot-social-css'
        style.textContent = CSS
        document.head.appendChild(style)
      }, [])
    }
    const initial = name => (String(name ?? '?').replace(/^@/, '').trim()[0] ?? '?').toUpperCase()

    // Same FNV-1a as core lookOf, so a missing host BotMark still paints a stable per-Bot
    // color (never the shared gray letter badge) and two ids do not collide.
    const FACE_INKS = ['#e5484d', '#e54666', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#3e63dd', '#5b5bd6', '#8e4ec6']
    function inkOf(seed) {
      const text = String(seed ?? '')
      let value = 2166136261
      for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619)
      return FACE_INKS[(value >>> 0) % FACE_INKS.length]
    }
    function faceSeed(bot) {
      const handle = typeof bot?.remote?.handle === 'string' && bot.remote.handle.trim()
        ? bot.remote.handle
        : typeof bot?.handle === 'string' && bot.handle.trim() && bot.remote
          ? bot.handle
          : ''
      if (handle) return `remote:${handle.trim().replace(/^@+/, '').toLowerCase()}`
      if (bot?.id !== undefined) return String(bot.id)
      if (typeof bot?.handle === 'string' && bot.handle.trim()) return `remote:${bot.handle.trim().replace(/^@+/, '').toLowerCase()}`
      return String(bot?.name ?? '')
    }
    function rosterBot(roster, id) {
      if (!id) return undefined
      return roster?.byId?.[id] ?? (roster?.bots ?? []).find(bot => bot.id === id)
    }
    function chatByHandle(remoteChats, handle) {
      if (!handle) return undefined
      return (remoteChats ?? []).find(chat => chat.remote?.handle === handle)
    }
    // Local picker rows use the team roster record (configured image / shape / color).
    // Waiting-room "mine" matches the same local Bot; a friend's Bot uses its chat
    // record or a handle-seeded remote look, plus any avatar the member payload carries.
    function faceLook({ roster, remoteChats, bots, local, member } = {}) {
      if (local) {
        const full = rosterBot(roster, local.id)
        return full ? { ...local, ...full } : local
      }
      if (!member) return undefined
      const mine = (bots ?? []).find(bot => bot.handle && bot.handle === member.handle)
      if (mine) return faceLook({ roster, bots, local: mine })
      const extra = {}
      if (member.color) extra.color = member.color
      if (member.avatar) extra.avatar = member.avatar
      const chat = chatByHandle(remoteChats, member.handle)
      if (chat) {
        return {
          ...chat,
          name: member.displayName || chat.name,
          remote: chat.remote ?? { handle: member.handle },
          ...extra,
        }
      }
      return {
        id: member.botId || member.handle,
        name: member.displayName || member.label || member.handle,
        handle: member.handle,
        remote: member.handle ? { handle: member.handle } : undefined,
        ...extra,
      }
    }
    function FaceAvatar({ bot, size = 24 } = {}) {
      const Avatar = globalThis.__flybot__?.BotAvatar
      const Mark = globalThis.__flybot__?.BotMark
      const seed = faceSeed(bot)
      const color = typeof bot?.color === 'string' && bot.color.startsWith('#') ? bot.color : inkOf(seed)
      let inner
      if (typeof Avatar === 'function' && bot) inner = h(Avatar, { bot, size, badge: false, live: false })
      else if (typeof Mark === 'function' && bot) inner = h(Mark, { bot, size })
      else {
        const image = bot?.avatar?.image
        const emoji = bot?.avatar?.emoji
        inner = h('span', {
          className: 'fs-avatar',
          'data-color': color,
          style: image ? undefined : { background: color, color: '#fff' },
        }, image ? h('img', { src: image, alt: '' }) : (emoji || initial(bot?.name)))
      }
      return h('span', {
        className: 'fs-face-mark',
        'data-flybot': 'face-avatar',
        'data-bot-id': bot?.id,
        'data-handle': bot?.remote?.handle || bot?.handle,
        'data-color': color,
        'data-size': size,
        'aria-hidden': true,
        style: { width: size, height: size, '--fs-face-size': `${size}px` },
      }, inner)
    }

    function faceTileParts(member) {
      const owner = String(member?.ownerName ?? member?.owner_name ?? '').trim()
      const raw = String(member?.displayName || member?.name || '').trim()
      let name = raw
      if (!name || /^bot$/i.test(name) || (owner && name.toLowerCase() === owner.toLowerCase())) {
        const fromLabel = String(member?.label ?? '').split('·')[0].replace(/'s Chief$/i, 'Chief').trim()
        if (fromLabel && !/^bot$/i.test(fromLabel) && (!owner || fromLabel.toLowerCase() !== owner.toLowerCase())) name = fromLabel
        else {
          const handleText = typeof member?.handle === 'object' && member.handle
            ? String(member.handle.handle ?? '')
            : String(member?.handle ?? '')
          const part = handleText.replace(/^@/, '').split('.')[0]
          name = part && part !== 'home' && part !== 'bot'
            ? part.charAt(0).toUpperCase() + part.slice(1)
            : (raw || 'Bot')
        }
      }
      if (/^chief$/i.test(name)) name = 'Chief'
      return { name: name || 'Bot', owner }
    }

    function FaceTile({ bot, name, owner, member, handle, mine, pick, selected, onToggle } = {}) {
      const parts = member ? faceTileParts(member) : { name: name || 'Bot', owner: owner || '' }
      const title = (member ? [parts.owner, parts.name] : [parts.name, parts.owner]).filter(Boolean).join(' · ')
      const mark = h('span', { className: 'fs-tile-mark' },
        h(FaceAvatar, { bot, size: 48 }),
        mine
          ? h('span', { className: 'fs-tile-mine', 'data-flybot': 'face-mine', title: 'mine', 'aria-label': 'mine' })
          : null,
        pick && selected
          ? h('span', { className: 'fs-tile-check', 'data-flybot': 'face-pick-check', 'aria-hidden': true }, '✓')
          : null)
      // A joined member leads with the person, so two Chiefs are told apart at a glance (#229).
      const caption = member && parts.owner
        ? [
          h('span', { key: 'o', className: 'fs-tile-name', 'data-flybot': 'face-owner', title }, parts.owner),
          h('span', { key: 'n', className: 'fs-tile-sub', 'data-flybot': 'face-bot', title }, parts.name),
        ]
        : [
          h('span', { key: 'n', className: 'fs-tile-name', title }, parts.name),
          parts.owner ? h('span', { key: 'o', className: 'fs-tile-sub', 'data-flybot': 'face-owner', title: parts.owner }, parts.owner) : null,
        ]
      if (pick) {
        return h('li', { className: selected ? 'fs-tile fs-tile-on' : 'fs-tile' },
          h('label', { className: 'fs-tile-hit' },
            h('input', {
              type: 'checkbox',
              className: 'fs-sr',
              checked: !!selected,
              'aria-label': title,
              onChange: onToggle,
            }),
            mark,
            caption))
      }
      return h('li', {
        className: 'fs-tile',
        'data-flybot': 'face-member',
        'data-mine': mine || undefined,
        'data-handle': handle,
        title,
      }, mark, caption)
    }

    const AUTO_SEND_NOTE = "Don't ask each time."

    function FaceAutoSend({ on, busy, onChange, error, bot } = {}) {
      return h('div', { className: 'fs-face-auto-wrap', 'data-flybot': 'face-auto-send' },
        h('label', { className: 'fs-auto fs-face-auto', title: AUTO_SEND_NOTE },
          h('input', {
            type: 'checkbox',
            checked: on === true,
            disabled: !!busy,
            'aria-label': "Auto-send my Bot's room messages",
            onChange: e => onChange?.(e.target.checked),
          }),
          bot ? `Auto-send ${bot} → room` : 'Auto-send'),
        error ? h('div', { className: 'fs-status', 'data-tone': 'error', role: 'status' }, error) : null)
    }

    // Leave asks once (#182): leaving ends my part in the room for good.
    function ConfirmLeave({ busy, onLeave, flybot = 'face-leave', size = 'fs-btn fs-btn-sm' } = {}) {
      const [ask, setAsk] = useState(false)
      if (!ask) return h('button', { type: 'button', className: size, 'data-flybot': flybot, disabled: !!busy, onClick: () => setAsk(true) }, 'Leave')
      return h('span', { className: 'fs-leave-ask', 'data-flybot': 'face-leave-confirm' },
        h('span', { className: 'fs-hint' }, 'Leave this room?'),
        h('button', { type: 'button', className: size, 'data-flybot': 'face-leave-yes', disabled: !!busy, onClick: () => { setAsk(false); onLeave?.() } }, 'Leave'),
        h('button', { type: 'button', className: size, 'data-flybot': 'face-leave-no', onClick: () => setAsk(false) }, 'Stay'))
    }

    function FaceAutoSendControl({ bot } = {}) {
      const [on, setOn] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      useEffect(() => {
        call('social/status', {}).then(value => setOn(value?.autoApproveFaceRooms === true), () => {})
      }, [])
      const toggle = async (next) => {
        setBusy(true)
        setError('')
        try {
          const result = await call('social/face-auto', { on: next })
          setOn(result?.autoApproveFaceRooms === true)
        } catch (e) { setError(errorText(e)) }
        finally { setBusy(false) }
      }
      return h(FaceAutoSend, { on, busy, onChange: toggle, error, bot })
    }

    const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
    const looksLikeBotId = (value) => /^bot_[a-z0-9]+$/i.test(String(value ?? '').trim())
    const looksLikeHandle = (value) => /^@[\w.-]+$/.test(String(value ?? '').trim())
    function readableParty(value, fallback = '') {
      const text = (typeof value === 'object' && value
        ? String(value.owner_display_name || value.display_name || value.handle || value.name || '')
        : String(value ?? '')).trim()
      if (!text || looksLikeBotId(text)) return fallback
      if (looksLikeHandle(text)) {
        const body = text.replace(/^@+/, '').split('.')[0]
        if (!body || looksLikeBotId(body)) return fallback
        return body.charAt(0).toUpperCase() + body.slice(1)
      }
      return text
    }
    function pendingTitle(item) {
      const from = readableParty(item.from, 'Bot')
      const to = readableParty(item.toName) || (item.kind === 'face_room_message' ? 'the room' : readableParty(item.to, 'friend'))
      return item.from || item.to || item.toName ? `${from} → ${to}` : (to || 'Outbound reply')
    }

    // Compact jump list. Approve / Reject live on the in-chat card.
    function PendingApprovals({ items, onOpen }) {
      if (!items?.length) return null
      return h('div', { className: 'fs-pending', 'data-flybot': 'pending-approvals', role: 'region', 'aria-label': 'Messages waiting for your approval' },
        h('div', { className: 'fs-label' }, 'Waiting for your approval', h('span', { className: 'fs-count' }, String(items.length))),
        items.map(item => h('button', {
          key: item.id, type: 'button', className: 'fs-pending-item', 'data-flybot': 'pending-item',
          title: oneLine(item.text || item.summary || pendingTitle(item)),
          onClick: () => onOpen?.(item),
        },
          h('span', { className: 'fs-text' },
            h('span', { className: 'fs-name' }, pendingTitle(item)),
            h('span', { className: 'fs-pending-one' }, oneLine(item.text || item.summary || ''))))))
    }

    const STOP_JOIN = /6-digit|no longer valid|Too many (failed )?attempts|signed you out/i
    function shouldStopJoin(e) {
      const code = String(e?.code ?? '')
      if (['invalid_code', 'code_void', 'locked_out', 'unauthorized', 'rate_limited'].includes(code)) return true
      return STOP_JOIN.test(String(e?.message ?? e ?? ''))
    }
    function memberIsMine(member, bots, room) {
      if (member?.remote === false) return true
      const handle = typeof member?.handle === 'object' && member.handle
        ? String(member.handle.handle ?? '')
        : String(member?.handle ?? '')
      if (!handle) return false
      if ((room?.mineHandles ?? []).includes(handle)) return true
      return (bots ?? []).some(bot => bot.handle === handle)
    }

    function faceWaitCode(room, typed) {
      const fromRoom = String(room?.joinCode || room?.code || '').replace(/\D/g, '').slice(0, 6)
      if (fromRoom.length === 6) return fromRoom
      const fromTyped = String(typed || '').replace(/\D/g, '').slice(0, 6)
      return fromTyped.length === 6 ? fromTyped : ''
    }
    function FaceWaitCode({ code } = {}) {
      const digits = String(code || '').replace(/\D/g, '').slice(0, 6)
      if (digits.length !== 6) return null
      return h('div', { className: 'fs-wait-code', 'data-flybot': 'face-wait-code', 'aria-label': `Room number ${digits}` },
        h('div', { className: 'fs-wait-code-label' }, 'Room number'),
        h('div', { className: 'fs-wait-code-digits', 'data-flybot': 'face-wait-code-digits' }, digits))
    }
    function shownHoldText(value) {
      const raw = String(value ?? '')
      const mark = 'FLYBOT-FACE-HUMAN'
      const at = raw.indexOf(mark)
      if (at < 0) return stripHoldPrefix(raw)
      const start = raw.indexOf('{', at)
      if (start < 0) return raw.slice(0, at).trim()
      let depth = 0
      let end = -1
      for (let i = start; i < raw.length; i += 1) {
        const ch = raw[i]
        if (ch === '{') depth += 1
        else if (ch === '}') {
          depth -= 1
          if (depth === 0) { end = i; break }
        }
      }
      if (end < 0) return stripHoldPrefix(raw.slice(0, at).trim())
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1))
        const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
        if (text) return stripHoldPrefix(text)
      } catch { /* fall through */ }
      return stripHoldPrefix(raw.slice(0, at).trim())
    }
    function stripHoldPrefix(text) {
      return String(text ?? '').replace(/^(to (the )?face[ -]?room|to the room)\s*:\s*/i, '').trim()
    }

    // The room the Face-to-face dialog is waiting in: the details panel draws no second
    // waiting card for it (#306).
    const faceDialog = {
      roomId: null,
      listeners: new Set(),
      show(id) {
        const next = id || null
        if (next === this.roomId) return
        this.roomId = next
        for (const fn of [...this.listeners]) fn()
      },
      subscribe(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
    }
    // Every Leave lands on the main Bot, not on the room just left (#182, #306).
    function openMainBot(roster, actions) {
      // The roster names the Main Bot by id (`mainBotId`); its bot records carry no `isMain`.
      const id = roster?.mainBotId
        || (roster?.bots ?? []).find(bot => bot.isMain)?.id
        || roster?.bots?.[0]?.id
      if (id && typeof actions?.openSession === 'function') actions.openSession(id)
    }

    // Separate Face-to-face group screen (#92): pick Bots, join by number, live waiting room.
    function FaceToFaceGroup({ actions, onClose, roster, remoteChats } = {}) {
      const [step, setStep] = useState('setup')
      const [bots, setBots] = useState([])
      const [selected, setSelected] = useState([])
      const [code, setCode] = useState('')
      const [busy, setBusy] = useState(false)
      const [status, setStatus] = useState(null)
      const [failures, setFailures] = useState([])
      const [room, setRoom] = useState(null)
      const [tick, setTick] = useState(0)
      const opened = useRef(false)
      useEffect(() => {
        faceDialog.show(step === 'waiting' ? room?.roomId : null)
        return () => faceDialog.show(null)
      }, [step, room?.roomId])
      useEffect(() => {
        call('social/status', {}).then(value => {
          const list = value?.bots ?? []
          setBots(list)
          setSelected(current => {
            if (current.length) return current
            const main = list.find(bot => bot.isMain) ?? list[0]
            return main ? [main.id] : []
          })
        }, () => {})
      }, [])
      useEffect(() => {
        if (!onClose || typeof document?.addEventListener !== 'function') return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); onClose() }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])
      useEffect(() => {
        if (step !== 'waiting' || !(room?.faceRoomId || room?.roomId)) return undefined
        const faceId = room.faceRoomId
        const localId = room.roomId
        const load = () => call('social/face-rooms', { poll: true }).then(value => {
          const list = Array.isArray(value?.rooms) ? value.rooms : []
          const next = list.find(item => (faceId && item.faceRoomId === faceId) || (localId && item.roomId === localId))
          if (next) setRoom(current => current ? { ...current, ...next } : next)
        }, () => {})
        load()
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(load, 2000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [step, room?.faceRoomId, room?.roomId])
      useEffect(() => {
        if (step !== 'waiting' || room?.status !== 'candidate' || !room?.expiresAt) return undefined
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => setTick(n => n + 1), 1000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [step, room?.status, room?.expiresAt])
      useEffect(() => {
        if (step !== 'waiting' || room?.status !== 'open' || opened.current) return undefined
        const id = room.roomId
        if (!id || typeof actions?.openSession !== 'function') return undefined
        opened.current = true
        actions.openSession(id)
        onClose?.()
        return undefined
      }, [step, room?.status, room?.roomId])
      const join = async (event) => {
        event?.preventDefault?.()
        const digits = String(code).replace(/\D/g, '').slice(0, 6)
        if (digits.length !== 6) {
          setStatus({ tone: 'error', text: 'Enter a 6-digit number.' })
          return
        }
        if (!selected.length) {
          setStatus({ tone: 'error', text: 'Choose which of your Bots join.' })
          return
        }
        setBusy(true)
        setStatus(null)
        setFailures([])
        const mine = []
        const failed = []
        let last
        for (const botId of selected) {
          const bot = bots.find(item => item.id === botId)
          try {
            const result = await call('social/face-join', { code: digits, botId })
            last = result
            if (result?.joinedAs?.handle) mine.push(result.joinedAs.handle)
          } catch (e) {
            failed.push({ botId, name: bot?.name || 'Bot', text: errorText(e) })
            if (shouldStopJoin(e) && !last) {
              setStatus({ tone: 'error', text: errorText(e) })
              setFailures(failed)
              setBusy(false)
              return
            }
            if (shouldStopJoin(e)) break
          }
        }
        setFailures(failed)
        if (!last) {
          setStatus({ tone: 'error', text: failed[0]?.text || 'Could not join that room. Try another number.' })
          setBusy(false)
          return
        }
        setRoom({ ...last, mineHandles: mine, joinCode: last.joinCode || digits })
        setStep('waiting')
        setBusy(false)
        // The main pane (and its title) moves to the new room at once, not the room before it (#191).
        if (last.roomId && typeof actions?.openSession === 'function') actions.openSession(last.roomId)
      }
      const enter = async () => {
        if (!room || opened.current) return
        setBusy(true)
        setStatus(null)
        try {
          let next = room
          if (room.status === 'candidate') {
            next = await call('social/face-start', { roomId: room.roomId, faceRoomId: room.faceRoomId })
            setRoom(current => current ? { ...current, ...next, status: 'open' } : { ...next, status: 'open' })
          }
          const id = next?.roomId || room.roomId
          opened.current = true
          if (id && typeof actions?.openSession === 'function') actions.openSession(id)
          onClose?.()
        } catch (e) {
          setStatus({ tone: 'error', text: errorText(e) })
        } finally { setBusy(false) }
      }
      const leave = async () => {
        setBusy(true)
        setStatus(null)
        try {
          if (room?.faceRoomId || room?.roomId) {
            await call('social/face-leave', { roomId: room.roomId, faceRoomId: room.faceRoomId })
          }
          openMainBot(roster, actions)
          onClose?.()
        } catch (e) {
          setStatus({ tone: 'error', text: errorText(e) })
        } finally { setBusy(false) }
      }
      const toggle = (id) => {
        setSelected(list => list.includes(id) ? list.filter(item => item !== id) : [...list, id])
      }
      const members = room?.members ?? []
      const candidate = room?.status === 'candidate'
      const waiting = step === 'waiting' && room
      return h('div', { className: 'fs-dialog-back', 'data-flybot': 'face-group', role: 'dialog', 'aria-label': 'Face-to-face group' },
        h('div', { className: 'fs-dialog' },
          h('div', { className: 'fs-dialog-head' },
            h('div', { className: 'fs-name' }, 'Face-to-face group'),
            h('button', { type: 'button', className: 'fs-btn fs-btn-sm', onClick: () => onClose?.() }, 'Close')),
          waiting ? h('div', { className: 'fs-wait', 'data-flybot': 'face-wait' },
            h(FaceWaitCode, { code: faceWaitCode(room, code) }),
            h('div', { className: 'fs-hint fs-wait-count', 'data-flybot': 'face-wait-count', 'data-tick': tick }, candidate
              ? (room.expiresAt ? countdown(room.expiresAt) : 'Anyone with the number can still join.')
              : 'The room is open. The number is no longer valid.'),
            h('div', { className: 'fs-wait-body' },
              h('ul', { className: 'fs-tiles fs-wait-roster', 'data-flybot': 'face-wait-roster', 'aria-label': 'Who has joined' },
                members.map(member => h(FaceTile, {
                  key: member.handle || member.id,
                  bot: faceLook({ roster, remoteChats, bots, member }),
                  member,
                  handle: member.handle,
                  mine: memberIsMine(member, bots, room),
                }))),
              members.length === 0 ? h('div', { className: 'fs-hint' }, 'Waiting for others to join…') : null,
              failures.length ? h('div', { className: 'fs-status', 'data-tone': 'error', 'data-flybot': 'face-join-fail', role: 'status' },
                failures.map(item => `${item.name}: ${item.text}`).join(' ')) : null,
              status ? h('div', { className: 'fs-status', 'data-tone': status.tone, role: 'status' }, status.text) : null),
            h('div', { className: 'fs-wait-foot', 'data-flybot': 'face-wait-foot' },
              h(ConfirmLeave, { busy, onLeave: leave, size: 'fs-btn' }),
              h('button', {
                type: 'button', className: 'fs-btn fs-btn-primary', 'data-flybot': 'face-enter',
                disabled: !!busy || !room.roomId, onClick: enter,
              }, 'Enter chat'))) : h('form', { onSubmit: join, 'data-flybot': 'face-join' },
            h('div', { className: 'fs-hint' }, 'Pick your Bots and enter the same 6-digit number as everyone nearby.'),
            h('ul', { className: 'fs-tiles fs-pick', 'data-flybot': 'face-pick', 'aria-label': 'Your Bots' },
              bots.map(bot => h(FaceTile, {
                key: bot.id,
                bot: faceLook({ roster, local: bot }),
                name: bot.name,
                pick: true,
                selected: selected.includes(bot.id),
                onToggle: () => toggle(bot.id),
              }))),
            bots.length === 0 ? h('div', { className: 'fs-hint' }, 'Loading your Bots…') : null,
            h('div', { className: 'fs-hint', 'data-flybot': 'face-join-room' },
              'Room-only: friends do not see these Bots unless you invite them.'),
            h('div', { className: 'fs-line' },
              h('input', {
                className: 'fs-digits', value: code, inputMode: 'numeric', autoComplete: 'off', maxLength: 6,
                placeholder: '6 digits', 'aria-label': '6-digit room number',
                onChange: e => setCode(String(e.target.value).replace(/\D/g, '').slice(0, 6)),
              }),
              h('button', {
                type: 'submit', className: 'fs-btn',
                // Enabled once a Bot is picked: a short number answers with the inline hint, never a silent grey button (#306).
                disabled: busy || !selected.length,
                title: selected.length ? undefined : 'Pick a Bot first.',
              }, 'Join')),
            !selected.length && bots.length ? h('div', { className: 'fs-hint', 'data-flybot': 'face-join-pick' }, 'Pick a Bot first.') : null,
            failures.length ? h('div', { className: 'fs-status fs-fail', 'data-tone': 'error', 'data-flybot': 'face-join-fail', role: 'status' },
              failures.map(item => `${item.name}: ${item.text}`).join(' ')) : null,
            status ? h('div', { className: 'fs-status', role: 'status', 'data-tone': status.tone }, status.text) : null)))
    }

    function faceChip(room) {
      if (room.status === 'closed') return 'closed'
      if (room.status === 'left') return 'left'
      if (room.status === 'candidate') {
        if (!room.expiresAt) return 'joining'
        const at = Date.parse(room.expiresAt)
        if (!Number.isFinite(at)) return 'joining'
        const left = Math.max(0, at - Date.now())
        if (left <= 0) return 'ended'
        const minutes = Math.ceil(left / 60_000)
        if (minutes >= 1) return `${minutes}m`
        return `${Math.max(1, Math.ceil(left / 1000))}s`
      }
      return 'open'
    }
    function faceChipLabel(room) {
      const chip = faceChip(room)
      if (chip === 'open') return 'Open'
      if (chip === 'closed') return 'Closed'
      if (chip === 'left') return 'Left'
      if (chip === 'ended') return 'ended'
      if (chip === 'joining') return 'Joining'
      return chip
    }
    // Past rooms read like the room's tab and sidebar row (#304): `Face-to-face · Alice, Bob · 482913`.
    // People come from every member when the row has them (a stored auto name can miss one), the
    // number from the row or its stored title, else the time the room was created.
    function shownFaceTitle(room) {
      const named = String(room?.name || '').trim()
      if (named && named !== 'Face-to-face room' && !named.startsWith('Face-to-face · ')) return named
      if (named.startsWith('Face-to-face · ') && !(room?.members ?? []).some(m => String(m?.ownerName || m?.owner_name || '').trim())) return named
      const rows = []
      const seen = new Set()
      for (const member of room?.members ?? []) {
        const owner = String(member.ownerName || member.owner_name || '').trim()
        const key = owner.toLowerCase()
        if (!owner || seen.has(key)) continue
        seen.add(key)
        const handle = String(member.handle || member.id || '').trim().toLowerCase()
        rows.push({ owner, sort: handle || key })
      }
      rows.sort((a, b) => a.sort.localeCompare(b.sort))
      const owners = rows.slice(0, 3).map(row => row.owner)
      const stored = named.match(/ · (\d{6})$/)?.[1]
      const code = String(room?.joinCode || room?.code || stored || '').replace(/\D/g, '').slice(0, 6)
      const bits = ['Face-to-face']
      if (owners.length) bits.push(owners.join(', '))
      const storedWhen = named.match(/ · ([A-Z][a-z]{2} \d{1,2} \d{2}:\d{2})$/)?.[1]
      if (code.length === 6) bits.push(code)
      else if (storedWhen) bits.push(storedWhen)
      else {
        // Created = the joining deadline minus the 10-minute window, never the deadline itself.
        const deadline = Date.parse(room?.expiresAt || '')
        const at = Date.parse(room?.createdAt || '') || (Number.isFinite(deadline) ? deadline - 10 * 60_000 : Date.parse(room?.startedAt || ''))
        const when = Number.isFinite(at) ? new Date(at) : new Date()
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        bits.push(`${months[when.getMonth()]} ${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`)
      }
      return bits.join(' · ')
    }
    function FaceRoomCard({ room, actions, onChange, roster, remoteChats, past } = {}) {
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState(null)
      const run = async (label, fn) => {
        setBusy(label)
        setNote(null)
        try {
          await fn()
          onChange?.()
        } catch (e) { setNote({ tone: 'error', text: errorText(e) }) }
        finally { setBusy('') }
      }
      const members = room.members ?? []
      const shown = members.slice(0, 3)
      const extra = Math.max(0, members.length - shown.length)
      const look = (m) => (m.remote === false || m.id && roster?.byId?.[m.id]
        ? faceLook({ roster, local: roster?.byId?.[m.id] || { id: m.id, name: m.displayName } })
        : faceLook({ roster, remoteChats, member: m }))
      const openable = Boolean(room.faceRoomId || room.roomId)
      const open = async () => {
        if (!openable || typeof actions?.openSession !== 'function') return
        setBusy('open')
        setNote(null)
        try {
          const next = await call('social/face-open', { roomId: room.roomId, faceRoomId: room.faceRoomId })
          const id = next?.roomId || room.roomId
          if (id) actions.openSession(id)
        } catch (e) { setNote({ tone: 'error', text: errorText(e) }) }
        finally { setBusy('') }
      }
      return h('div', { className: 'fs-face-item', 'data-flybot': 'face-room', 'data-status': room.status, 'data-past': past || undefined },
        h('div', {
          className: 'fs-face-row',
          'data-open': openable ? true : undefined,
          onClick: openable ? () => open() : undefined,
        },
          h('span', { className: 'fs-stack', 'aria-label': 'Members' },
            shown.map(m => h('span', { key: m.handle || m.id, 'data-flybot': 'face-card-member', 'data-handle': m.handle },
              h(FaceAvatar, { bot: look(m), size: 20 }))),
            extra ? h('span', { className: 'fs-stack-more' }, `+${extra}`) : null),
          // One line; the full title on hover when the narrow sidebar cuts it (#304).
          h('span', { className: 'fs-name', title: shownFaceTitle(room) }, shownFaceTitle(room)),
          h('span', { className: 'fs-chip fs-chip-status', 'data-flybot': 'face-status', 'data-status': faceChip(room) }, faceChipLabel(room)),
          h('span', { className: 'fs-face-actions', onClick: event => event.stopPropagation() },
            past
              ? (openable ? h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: !!busy, onClick: () => open() }, 'Open') : null)
              : h(ConfirmLeave, { busy, onLeave: () => run('leave', () => call('social/face-leave', { roomId: room.roomId, faceRoomId: room.faceRoomId })) }))),
        note ? h('div', { className: 'fs-status', 'data-tone': note.tone }, note.text) : null)
    }

    const WAITING_OWNER = 'Waiting for approval'
    const WAITING_OTHERS = "Waiting for the owner's approval"

    function holdParties(item) {
      const from = readableParty(item?.from, 'Bot')
      const to = readableParty(item?.toName) || (item?.kind === 'face_room_message' ? 'the room' : readableParty(item?.to, 'friend'))
      return { from, to }
    }
    const autoSendToast = (from, to) => `Auto-send on for ${from} → ${to}. Change it anytime in settings.`
    function homeOfHandle(value) {
      const raw = typeof value === 'object' && value
        ? String(value.handle ?? value.home ?? '')
        : String(value ?? '')
      const body = raw.trim().replace(/^@+/, '').toLowerCase()
      if (!body) return ''
      const parts = body.split('.')
      if (parts.length >= 2 && parts.at(-1) === 'home') return `@${parts.at(-2)}.home`
      return `@${body}`
    }

    // Why Bot Social held a send, in words (#371). `t` is the host's translator (zh in a zh UI); without one the
    // English stays. A category this build does not know is left out, never shown raw.
    const HOLD_REASON_WORDS = {
      commitment: 'commitment language', 'pii.phone': 'a phone number', 'pii.email': 'an email address', money: 'a money amount',
      'owner.sensitive_term': 'one of your sensitive terms', 'calendar.details': 'calendar details',
    }
    function holdReasonLine(reasons, t) {
      const tr = typeof t === 'function' ? t : (key, params) => String(key).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
      const words = (Array.isArray(reasons) ? reasons : []).filter(name => Object.hasOwn(HOLD_REASON_WORDS, name)).map(name => tr(HOLD_REASON_WORDS[name]))
      return words.length ? tr('Held for your approval: contains {reasons}', { reasons: words.join(tr(', ')) }) : ''
    }
    function ChatApproval({ item, canDecide = true, busy, onDecide, t } = {}) {
      const [open, setOpen] = useState(false)
      if (!item) return null
      if (item.status === 'approved' || item.status === 'rejected') {
        return h('div', { className: 'fs-hold fs-chat-approval', 'data-flybot': 'chat-approval', 'data-state': item.status, role: 'status' },
          h('div', { className: 'fs-name' }, item.status === 'approved' ? 'Approved' : 'Rejected'))
      }
      if (canDecide !== true) {
        return h('div', { className: 'fs-hold fs-chat-approval', 'data-flybot': 'chat-approval', 'data-role': 'other', role: 'status' },
          h('div', { className: 'fs-name' }, WAITING_OTHERS))
      }
      const { from, to } = holdParties(item)
      const text = shownHoldText(item.text || item.summary || '')
      const long = text.length > 160 || text.split(/\n/).length > 3
      const reasonLine = holdReasonLine(item.reasons, t)
      return h('div', { className: 'fs-hold fs-chat-approval', 'data-flybot': 'chat-approval', 'data-role': 'owner', role: 'region', 'aria-label': WAITING_OWNER },
        h('div', { className: 'fs-label' }, WAITING_OWNER),
        item.from || item.to || item.toName || item.kind === 'face_room_message'
          ? h('div', { className: 'fs-sub' }, `${from} → ${to}`)
          : null,
        reasonLine ? h('div', { className: 'fs-sub', 'data-flybot': 'hold-reason' }, reasonLine) : null,
        text ? h('div', { className: 'fs-draft', 'data-clamp': !open && long ? true : undefined }, text) : null,
        long ? h('button', {
          type: 'button', className: 'fs-hold-more', 'data-flybot': 'hold-expand',
          onClick: () => setOpen(value => !value),
        }, open ? 'Show less' : 'Show more') : null,
        h('div', { className: 'fs-actions fs-chat-actions' },
          // The two decisions stay together on the right; the standing choice is left of them, or alone above when narrow (#271).
          h('span', { className: 'fs-hold-decide' },
            h('button', { type: 'button', className: 'fs-btn fs-btn-sm fs-btn-primary', disabled: !!busy, onClick: () => onDecide?.(item, 'approve') }, 'Approve'),
            h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: !!busy, onClick: () => onDecide?.(item, 'reject') }, 'Reject')),
          // Two buttons are the decision; the standing choice is a quiet link, not a third button (#260).
          h('button', { type: 'button', className: 'fs-link fs-hold-always', 'data-flybot': 'hold-always', disabled: !!busy, onClick: () => onDecide?.(item, 'always') }, 'Always approve')))
    }

    function approvalsForOpenChat(items, { sessionId, room, bot, roster } = {}) {
      const list = Array.isArray(items) ? items : []
      const handle = bot?.remote?.handle
      const faceId = room?.face?.roomId
      const handles = new Set((room?.participants ?? []).map(p => p.handle).filter(Boolean))
      if (handle) handles.add(handle)
      return list.filter(item => {
        if (item.kind === 'face_room_message') {
          // A room line belongs to the one room it was held in (#188); no room means no card.
          if (faceId && item.roomId === faceId) return true
          return Boolean(room?.id && item.roomId === room.id)
        }
        if (faceId && item.roomId === faceId) return true
        if (room?.id && item.roomId === room.id) return true
        if (item.roomId) return false
        // A held reply or message a local Bot wrote shows in that Bot's own chat, where its owner is (#254).
        // One place per approval: once the friend's chat exists, that chat alone shows it (#278).
        if (item.fromId && bot?.id && !bot.remote && item.fromId === bot.id) return !listedFriendChat(roster, item.to)
        // A Bot's direct message to a friend belongs to the Bot's chat and the friend's chat, never to
        // a room that merely has that friend in it (#260). Bot Social's own holds still match by handle.
        if (item.source === 'local' && room) return false
        // The same for Bot Social's own: a Face-to-face room holds lines for its room id only (#271).
        if (room?.origin === 'face-to-face') return false
        if (item.to && handles.has(item.to)) return true
        if (sessionId && item.sessionId === sessionId) return true
        return false
      })
    }

    function friendChatOf(roster, handle) {
      const want = String(handle ?? '').trim().toLowerCase()
      if (!want.startsWith('@')) return undefined
      return (roster?.bots ?? []).find(item => item?.remote && String(item.remote.handle ?? '').toLowerCase() === want)
    }
    // A friend's chat that can be opened: in the list, not hidden, not gone, not a home-level handle. A hold to
    // any other chat has no card there, so the sender Bot's own chat shows it (#371).
    function listedFriendChat(roster, handle) {
      const bot = friendChatOf(roster, handle)
      if (!bot || bot.hidden || bot.remote.gone || bot.remote.hidden) return undefined
      const parts = String(bot.remote.handle).replace(/^@/, '').toLowerCase().split('.')
      return parts.length === 2 && parts[1] === 'home' ? undefined : bot
    }
    // A friend's Bot as the chat list names it: "UiA1415's Chief", "Helper · UiB1415's Bot" (#260).
    function friendLabel(roster, handle) {
      const bot = friendChatOf(roster, handle)
      if (!bot) return ''
      const owner = String(bot.remote.owner || bot.remote.homeName || '').trim()
      const name = String(bot.name ?? '').trim()
      if (!owner) return name
      return /^chief$/i.test(name) ? `${owner}'s Chief` : `${name} · ${owner}'s Bot`
    }
    function localHoldView(approval, roster) {
      if (!approval?.id) return undefined
      const to = approval.targetName ?? (typeof approval.request?.to === 'object' ? approval.request.to.handle : approval.request?.to)
      const composer = approval.request?.via === 'composer'
      return {
        id: approval.id,
        source: 'local',
        from: composer ? 'You' : approval.senderName,
        // The local Bot that wrote it (not a line you typed): its own chat shows the card (#254).
        ...(!composer && typeof approval.request?.from === 'string' ? { fromId: approval.request.from } : {}),
        to,
        toName: friendLabel(roster, to) || approval.targetName || to,
        text: approval.request?.text || approval.reason,
        // A friend's handle is an object, never a room: only a room id may sit here.
        roomId: approval.request?.meta?.roomId || (typeof approval.request?.to === 'string' ? approval.request.to : undefined),
        sessionId: approval.request?.meta?.sessionId,
      }
    }
    // The owner's own Bot Social handle at the top of the account menu, with copy (#181).
    function MyHandle() {
      useStyles()
      const [handle, setHandle] = useState('')
      const [copied, setCopied] = useState(false)
      useEffect(() => {
        let live = true
        call('social/status', {}).then(value => { if (live) setHandle(typeof value?.home === 'string' ? value.home : '') }, () => {})
        return () => { live = false }
      }, [])
      if (!handle) return null
      const copy = async () => {
        const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
        try {
          await clip?.writeText?.(handle)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch { /* clipboard denied: skip the Copied feedback */ }
      }
      return h('div', { className: 'fs-me', 'data-flybot': 'my-handle-menu' },
        h('span', { className: 'fs-me-handle', title: 'Your Bot Social handle' }, handle),
        h('button', { type: 'button', className: 'fs-link', 'data-flybot': 'copy-my-handle', onClick: copy }, copied ? 'Copied' : 'Copy'))
    }

    // A face-to-face room that has ended says so in plain view, naming the person who left (#191).
    function faceEndLine(room) {
      const status = room?.origin === 'face-to-face' ? room.face?.status : ''
      if (status !== 'left' && status !== 'closed') return ''
      const gone = (room.participants ?? []).filter(p => p.remote && p.leftSeq !== undefined)
        .map(p => p.ownerName || p.displayName || p.name).filter(Boolean)
      const names = [...new Set(gone)]
      // The one who left reads that they left; the others read who left (#304).
      if (status === 'left') return 'You left this room.'
      if (names.length > 0) return `${names.join(', ')} left the room. This room is closed.`
      return 'This room is closed.'
    }
    function FaceRoomStatus({ room } = {}) {
      const text = faceEndLine(room)
      return text ? h('div', { className: 'fs-room-end', 'data-flybot': 'face-room-end', role: 'status' }, text) : null
    }


    // "Name is thinking…" for friends' Bots (#297): one quiet line above the composer of a friend's chat or an
    // open face room. The host polls Bot Social only while this is mounted (`social/typing`); an older
    // server has no signal, so the line never shows and nothing else changes.
    function thinkingLine(names) {
      const list = names.filter(Boolean)
      if (list.length === 0) return ''
      if (list.length === 1) return `${list[0]} is thinking…`
      if (list.length === 2) return `${list[0]} and ${list[1]} are thinking…`
      return `${list[0]}, ${list[1]} and ${list.length - 2} more are thinking…`
    }
    // Which entries belong to this chat, and what to call them: the chat's own name for a friend's Bot, the
    // room's participant name (with the owner when two share a name) in a face room.
    function thinkingNames(items, { room, bot } = {}) {
      const handle = typeof bot?.remote?.handle === 'string' ? bot.remote.handle.trim().toLowerCase() : ''
      const faceId = room?.origin === 'face-to-face' && room.face?.status === 'open' ? room.face.roomId : ''
      const seen = new Set()
      const out = []
      for (const item of Array.isArray(items) ? items : []) {
        const mine = faceId
          ? item.scope === 'face_room' && item.roomId === faceId
          : handle !== '' && item.scope === 'direct' && String(item.handle).toLowerCase() === handle
        if (!mine || seen.has(item.handle)) continue
        seen.add(item.handle)
        if (!faceId) { out.push(String(bot.name || item.name || '').trim()); continue }
        const people = (room.participants ?? []).filter(p => p.remote)
        const own = people.find(p => String(p.handle ?? '').toLowerCase() === String(item.handle).toLowerCase())
        const name = String(own?.displayName || own?.name || item.name || '').trim()
        const clash = own && people.filter(p => String(p.displayName || p.name || '').trim() === name).length > 1
        out.push(clash && own.ownerName ? `${name} · ${own.ownerName}` : name)
      }
      return out
    }
    function PeerThinking({ room, bot } = {}) {
      useStyles()
      const [items, setItems] = useState([])
      const watching = Boolean((typeof bot?.remote?.handle === 'string' && bot.remote.handle) || (room?.origin === 'face-to-face' && room.face?.roomId && room.face.status === 'open'))
      useEffect(() => {
        if (!watching) { setItems([]); return undefined }
        let live = true
        const load = () => {
          if (typeof document !== 'undefined' && document.hidden) return
          call('social/typing', {}).then(value => { if (live) setItems(value?.supported === false ? [] : (Array.isArray(value?.typing) ? value.typing : [])) }, () => { if (live) setItems([]) })
        }
        load()
        if (typeof setInterval !== 'function') return () => { live = false }
        const timer = setInterval(load, 2000)
        timer?.unref?.()
        return () => { live = false; clearInterval(timer) }
      }, [watching, bot?.remote?.handle, room?.id, room?.face?.roomId, room?.face?.status])
      const text = thinkingLine(thinkingNames(items, { room, bot }))
      return text ? h('div', { className: 'fs-thinking', 'data-flybot': 'peer-thinking', role: 'status', 'aria-live': 'polite' }, h('span', { className: 'bt-shimmer' }, text)) : null
    }

    function ChatApprovalDock({ sessionId, roster, room, bot, actions, claim, t } = {}) {
      useStyles()
      const [items, setItems] = useState([])
      const [local, setLocal] = useState([])
      const [busy, setBusy] = useState('')
      const load = () => {
        call('social/status', {}).then(value => {
          setItems(Array.isArray(value?.approvals) ? value.approvals : [])
        }, () => {})
        call('approvals', { status: ['pending', 'failed'] }).then(list => {
          setLocal((Array.isArray(list) ? list : []).map(localHoldView).filter(Boolean))
        }, () => {})
      }
      useEffect(() => {
        load()
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(load, 5000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [])
      const session = { sessionId, roster, room, bot, handle: bot?.remote?.handle }
      // The friend's Bot by name and owner, as the chat list shows it.
      const named = list => list.map((item) => { const label = friendLabel(roster, item.to); return label ? { ...item, toName: label } : item })
      const mine = [
        ...approvalsForOpenChat(named(items), session),
        ...approvalsForOpenChat(named(local), session),
      ]
      // What this chat shows is its alone: the overlay draws no second card for the same approvals (#260).
      const shownIds = mine.map(item => item.id).join(',')
      useEffect(() => {
        if (typeof claim !== 'function') return undefined
        claim(shownIds ? shownIds.split(',') : [])
        return () => claim([])
      }, [shownIds, sessionId])
      const waitingOthers = mine.length === 0 && (room?.pendingCount ?? 0) > 0
      if (!mine.length && !waitingOthers) return null
      const decide = async (item, decision) => {
        setBusy(item.id)
        try {
          const always = decision === 'always'
          const mapped = always || decision === 'approve' || decision === 'approved' ? 'approve' : decision
          if (item.source === 'local') {
            await call('decide', { id: item.id, decision: mapped })
            if (always) {
              if (item.kind === 'face_room_message' || room?.origin === 'face-to-face') await call('social/face-auto', { on: true })
              else {
                const home = item.home || homeOfHandle(item.to)
                if (home) await call('social/auto-accept', { home, on: true })
              }
            }
          } else {
            await call('social/decide-approval', { approvalId: item.id, decision: mapped, ...(always ? { always: true } : {}) })
          }
          const status = mapped === 'reject' || mapped === 'rejected' ? 'rejected' : 'approved'
          const mark = list => list.map(entry => entry.id === item.id ? { ...entry, status } : entry)
          setItems(mark)
          setLocal(mark)
          if (always && status === 'approved') {
            const { from, to } = holdParties(item)
            actions?.notify?.(autoSendToast(from, to))
          }
        } finally { setBusy('') }
      }
      const approveAll = async () => {
        for (const item of mine.filter(entry => !entry.status)) await decide(item, 'approve')
      }
      if (waitingOthers) {
        return h('div', { 'data-flybot': 'chat-approvals' },
          h(ChatApproval, { item: { id: 'waiting' }, canDecide: false }))
      }
      return h('div', { 'data-flybot': 'chat-approvals' },
        mine.length > 1 && mine.some(entry => !entry.status)
          ? h('div', { className: 'fs-chat-actions' },
            h('button', { type: 'button', className: 'fs-btn fs-btn-sm', 'data-flybot': 'approve-all', disabled: !!busy, onClick: approveAll }, 'Approve all'))
          : null,
        mine.map(item => h(ChatApproval, {
          key: item.id, item, canDecide: true, busy: busy === item.id, onDecide: decide, t,
        })))
    }

    function FriendBotRow({ bot, chat, renderBot, busy, onRemove }) {
      const [menu, setMenu] = useState(false)
      const label = busy ? 'Removing…' : 'Remove this Bot'
      return h('div', {
        className: 'fs-row-wrap',
        'data-flybot': 'friend-bot',
        'data-handle': bot.handle,
        onContextMenu: (event) => { event?.preventDefault?.(); setMenu(true) },
      },
        chat && typeof renderBot === 'function'
          ? renderBot(chat)
          : h('div', { className: 'fs-row', title: bot.handle },
            h(FaceAvatar, { bot: faceLook({ member: { handle: bot.handle, displayName: bot.name, color: bot.color, avatar: bot.avatar } }), size: 24 }),
            h('span', { className: 'fs-text' }, h('span', { className: 'fs-name' }, bot.name), h('span', { className: 'fs-sub' }, bot.handle))),
        h('button', {
          type: 'button',
          className: 'fs-remove',
          'data-flybot': 'remove-friend-bot',
          title: 'Remove this Bot from Friends\' Bots and from your groups. This does not unfriend the owner.',
          'aria-label': label,
          'aria-busy': busy || undefined,
          disabled: !!busy,
          onClick: (event) => { event?.stopPropagation?.(); onRemove?.(bot) },
        }, busy ? '…' : '×'),
        menu ? h('div', { className: 'fs-menu', role: 'menu', 'data-flybot': 'friend-bot-menu' },
          h('button', { type: 'button', role: 'menuitem', onClick: () => { setMenu(false); onRemove?.(bot) } }, 'Remove this Bot')) : null)
    }

    function countdown(expiresAt) {
      const at = Date.parse(expiresAt)
      if (!Number.isFinite(at)) return 'Anyone with the number can still join'
      const left = Math.max(0, at - Date.now())
      if (left <= 0) return 'Joining has ended'
      // m:ss, so the line visibly ticks every second (#306); minutes alone looked frozen.
      const total = Math.max(1, Math.ceil(left / 1000))
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} left to join`
    }

    const isPastFace = (room) => {
      if (!room) return false
      if (room.status === 'closed' || room.status === 'left') return true
      return faceChip(room) === 'ended'
    }
    function uniqueFaceRooms(list) {
      const seen = new Set()
      const out = []
      for (const room of Array.isArray(list) ? list : []) {
        const id = room?.faceRoomId || room?.roomId
        if (id) {
          if (seen.has(id)) continue
          seen.add(id)
        }
        out.push(room)
      }
      return out
    }
    function FaceRooms({ actions, enabled = true, roster, remoteChats } = {}) {
      const [rooms, setRooms] = useState([])
      const [pastOpen, setPastOpen] = useState(false)
      const unique = uniqueFaceRooms(rooms)
      const past = unique.filter(isPastFace)
      const load = (poll = true) => call('social/face-rooms', { poll }).then(value => {
        setRooms(Array.isArray(value?.rooms) ? value.rooms : [])
      }, () => {})
      useEffect(() => {
        if (!enabled) return undefined
        load(true)
        if (typeof setInterval !== 'function') return undefined
        const tick = () => {
          if (typeof document !== 'undefined' && document.hidden) return
          load(true)
        }
        const timer = setInterval(tick, 5000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [enabled])
      if (!past.length) return null
      const card = (room, folded) => h(FaceRoomCard, {
        key: room.faceRoomId || room.roomId, room, past: folded, actions, onChange: () => load(true), roster, remoteChats,
      })
      return h('div', { 'data-flybot': 'face-rooms' },
        h('div', { className: 'fs-past', 'data-flybot': 'face-past' },
          h('button', { type: 'button', className: 'fs-past-head', 'aria-expanded': pastOpen, onClick: () => setPastOpen(open => !open) },
            h('span', { className: 'fs-chev', 'aria-hidden': true, 'data-closed': pastOpen ? undefined : true }, '▾'),
            'Past rooms',
            h('span', { className: 'fs-count' }, String(past.length))),
          pastOpen ? past.map(room => card(room, true)) : null))
    }

    function FaceRoomOverview({ room, roster, actions } = {}) {
      useStyles()
      const face = room?.origin === 'face-to-face' ? room.face : undefined
      if (room?.origin !== 'face-to-face') return null
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState(null)
      const [tick, setTick] = useState(0)
      const [snapshot, setSnapshot] = useState(null)
      const [, setDialogTick] = useState(0)
      useEffect(() => faceDialog.subscribe(() => setDialogTick(n => n + 1)), [])
      const candidate = (snapshot?.status || face?.status) === 'candidate'
      const live = candidate || (snapshot?.status || face?.status) === 'open'
      useEffect(() => {
        if (!live && face?.status !== 'candidate' && face?.status !== 'open') return undefined
        const load = () => call('social/face-rooms', { poll: true }).then(value => {
          const list = Array.isArray(value?.rooms) ? value.rooms : []
          const next = list.find(item => (face?.roomId && item.faceRoomId === face.roomId) || item.roomId === room.id)
          if (next) setSnapshot(next)
        }, () => {})
        load()
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(load, 3000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [live, face?.roomId, room?.id])
      useEffect(() => {
        const expiresAt = snapshot?.expiresAt || face?.expiresAt
        if (!candidate || !expiresAt) return undefined
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => setTick(n => n + 1), 1000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [candidate, snapshot?.expiresAt, face?.expiresAt])
      const run = async (label, fn) => {
        setBusy(label)
        setNote(null)
        try { await fn() } catch (e) { setNote({ tone: 'error', text: errorText(e) }) }
        finally { setBusy('') }
      }
      const members = snapshot?.members
        ?? (room.presentedParticipants ?? room.participants ?? []).filter(p => p.leftSeq === undefined)
      const expiresAt = snapshot?.expiresAt || face?.expiresAt
      const mineMember = member => member.remote === false || Boolean(member.id && roster?.byId?.[member.id])
      if (candidate) {
        // The open dialog already shows this waiting room: one card, not two (#306).
        if (room.id && faceDialog.roomId === room.id) return null
        return h('div', { className: 'fs-wait-overview', 'data-flybot': 'face-overview', 'data-wait': true },
          h(FaceWaitCode, { code: faceWaitCode(snapshot || face || room) }),
          h('div', { className: 'fs-hint fs-wait-count', 'data-tick': tick, 'data-flybot': 'face-wait-count' },
            expiresAt ? countdown(expiresAt) : 'Anyone with the number can still join.'),
          h('ul', { className: 'fs-tiles fs-wait-roster', 'data-flybot': 'face-wait-roster', 'aria-label': 'Who has joined' },
            members.map(member => h(FaceTile, {
              key: member.handle || member.id,
              // My own Bot looks as the roster draws it, as in the dialog (#306).
              bot: mineMember(member) && roster?.byId?.[member.id]
                ? faceLook({ roster, local: roster.byId[member.id] })
                : faceLook({ roster, member }),
              member,
              handle: member.handle,
              mine: mineMember(member),
            }))),
          members.length === 0 ? h('div', { className: 'fs-hint' }, 'Waiting for others to join…') : null,
          h('div', { className: 'fs-wait-foot', 'data-flybot': 'face-wait-foot' },
            h(ConfirmLeave, {
              busy,
              size: 'fs-btn',
              onLeave: () => run('leave', async () => {
                await call('social/face-leave', { roomId: room.id, faceRoomId: face?.roomId })
                openMainBot(roster, actions)
              }),
            }),
            h('button', {
              type: 'button', className: 'fs-btn fs-btn-primary', 'data-flybot': 'face-enter', disabled: !!busy,
              onClick: () => run('start', async () => {
                await call('social/face-start', { roomId: room.id, faceRoomId: face?.roomId })
                if (room.id && typeof actions?.openSession === 'function') actions.openSession(room.id)
              }),
            }, 'Enter chat')),
          note ? h('div', { className: 'fs-status', 'data-tone': note.tone }, note.text) : null)
      }
      const mineNames = members.filter(mineMember).map(member => member.displayName || member.name).filter(Boolean)
      const statusRoom = { status: snapshot?.status || face?.status || 'open', expiresAt: snapshot?.expiresAt || face?.expiresAt }
      if (statusRoom.status === 'left' || statusRoom.status === 'closed') {
        // A past room is read-only: its chip only, no Auto-send and no Leave (#304).
        return h('div', { className: 'fs-face-head', 'data-flybot': 'face-overview', 'data-past': true },
          h('span', { className: 'fs-chip fs-chip-status', 'data-flybot': 'face-status', 'data-status': faceChip(statusRoom) }, faceChipLabel(statusRoom)))
      }
      // Leave shares the status line, a row away from the Auto-send toggle, so a tap meant for one
      // never hits the other (#306).
      return h('div', { className: 'fs-face-head', 'data-flybot': 'face-overview' },
        h('div', { className: 'fs-face-top' },
          h('span', { className: 'fs-chip fs-chip-status', 'data-flybot': 'face-status', 'data-status': faceChip(statusRoom) }, faceChipLabel(statusRoom)),
          h('span', { className: 'fs-face-actions' },
            h(ConfirmLeave, {
              busy,
              onLeave: () => run('leave', async () => {
                await call('social/face-leave', { roomId: room.id, faceRoomId: face?.roomId })
                // Straight to the main Bot, not a blank pane while the room closes.
                openMainBot(roster, actions)
              }),
            }))),
        h(FaceAutoSendControl, { bot: mineNames[0] }),
        note ? h('div', { className: 'fs-status', 'data-tone': note.tone }, note.text) : null)
    }

    function makeOpener() {
      let handler = null
      let pending = false
      return {
        open() {
          if (handler) handler()
          else pending = true
        },
        bind(fn) {
          handler = fn
          if (pending) { pending = false; fn() }
          return () => { if (handler === fn) handler = null }
        },
      }
    }
    const facePanel = makeOpener()
    const addFriendPanel = makeOpener()
    const openFaceToFace = () => facePanel.open()
    const openAddFriend = () => addFriendPanel.open()

    function FriendsBots({ remoteChats, actions, roster } = {}) {
      useStyles()
      const [error, setError] = useState('')
      const [adding, setAdding] = useState(false)
      const [faceOpen, setFaceOpen] = useState(false)
      const loadApprovals = () => call('social/status', {}).then(() => {
        setError('')
      }, e => setError(errorText(e)))
      useEffect(() => {
        loadApprovals()
        if (typeof setInterval !== 'function') return undefined
        const tick = () => {
          if (typeof document !== 'undefined' && document.hidden) return
          loadApprovals()
        }
        const timer = setInterval(tick, 15_000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [])
      useEffect(() => facePanel.bind(() => setFaceOpen(true)), [])
      useEffect(() => addFriendPanel.bind(() => setAdding(true)), [])
      const unavailable = String(error).startsWith('Social is not running:')
      if (unavailable) {
        return h('section', { className: 'fs bt-social', 'aria-label': 'Social' },
          h('div', { className: 'fs-empty', 'data-flybot': 'social-unavailable' }, error))
      }
      return h('section', { className: 'fs bt-social', 'aria-label': 'Social' },
        error ? h('div', { className: 'fs-status', 'data-tone': 'error', style: { padding: '4px 10px' } }, error) : null,
        h(FaceRooms, { actions, enabled: true, roster, remoteChats }),
        adding ? h(AddFriend, { actions, onChange: loadApprovals, onDone: () => setAdding(false) }) : null,
        faceOpen ? h(FaceToFaceGroup, { actions, roster, remoteChats, onClose: () => setFaceOpen(false) }) : null)
    }

    // Add friend: join a friend's link and answer requests (invites are made from a Bot's right-click menu).
    function AddFriend({ onChange, onDone } = {}) {
      const [overview, setOverview] = useState(null)
      const [code, setCode] = useState('')
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      // Which of my Bots joins: the friend sees and reaches only that one (default: the Main Bot).
      const [mine, setMine] = useState([])
      const [joiner, setJoiner] = useState('')
      // Which of my Bots the copied invite shares (default: the Main Bot), and my own handle (#181).
      const [sharing, setSharing] = useState('')
      const [me, setMe] = useState('')
      // The link that was just made, kept on screen so it can be checked or copied by hand (#343).
      const [made, setMade] = useState(null)
      // `keep`: a result is on screen (an accepted invite, say); a failed re-read of the friend list must not
      // replace it with an error that looks like the action failed (#343).
      const refresh = (keep = false) => call('social/overview', {}).then(setOverview, (e) => { if (!keep) setStatus({ tone: 'error', text: errorText(e) }) })
      useEffect(() => {
        refresh()
        call('social/status', {}).then(value => {
          const bots = value?.bots ?? []
          setMine(bots)
          setMe(typeof value?.home === 'string' ? value.home : '')
          setJoiner(current => current || (bots.find(bot => bot.isMain) ?? bots[0])?.id || '')
          setSharing(current => current || (bots.find(bot => bot.isMain) ?? bots[0])?.id || '')
        }, () => {})
      }, [])
      useEffect(() => {
        if (!onDone || typeof document?.addEventListener !== 'function') return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); onDone() }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onDone])
      const run = async (label, fn) => {
        setBusy(true)
        setStatus(null)
        try {
          const message = await fn()
          if (message) setStatus({ tone: 'ok', text: message })
          await refresh(Boolean(message))
          onChange?.()
        } catch (e) {
          const text = errorText(e)
          setStatus({ tone: 'error', text: /^This invite was already used|^You're already friends/.test(text) ? text : `${label} failed: ${text}` })
        } finally {
          setBusy(false)
        }
      }
      const mint = () => run('Invite', async () => {
        const botId = sharing || mine.find(bot => bot.isMain)?.id || mine[0]?.id
        if (!botId) throw new Error('Choose one of your Bots to invite a friend to')
        const botName = mine.find(bot => bot.id === botId)?.name || 'your Bot'
        const invite = await call('social/create-invite', { botId })
        const link = invite?.link || invite?.url
        if (!link) throw new Error('The invite came back without its link')
        setMade({ link, botName })
        const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
        if (clip?.writeText) {
          try {
            await clip.writeText(link)
            return `Invite link for ${botName} copied. Send it to a friend.`
          } catch {
            return `Could not copy. Copy the link below and send it to a friend.`
          }
        }
        return 'Copy the link below and send it to a friend.'
      })
      const join = e => {
        e.preventDefault()
        return run('Accepting invite', async () => {
          const r = await call('social/join-invite', { code, ...(joiner ? { botId: joiner } : {}) })
          setCode('')
          const who = r.inviterName ?? r.inviter ?? 'Your friend'
          const shared = r.inviterBotName || r.sharedBot
          if (r.status === 'active') {
            // The panel stays open with the result until Done, so it can be read (#343). A join that
            // brought no Bot says so instead of claiming one was shared.
            return shared ? `${who} shared ${shared} with you.` : `Joined ${who}'s invite, but their Bot hasn't loaded yet. It shows in your list when it does; if not, accept the link again.`
          }
          return `Request sent to ${who}. They show up here once they accept.`
        })
      }
      const respond = (item, decision) => run(decision === 'accept' ? 'Accepting' : 'Declining', async () => {
        await call('social/respond', { relationshipId: item.relationshipId, decision })
        return decision === 'accept' ? `${item.name ?? item.handle} is now a friend.` : `Declined ${item.name ?? item.handle}.`
      })
      const incoming = overview?.incoming ?? []
      const outgoing = overview?.outgoing ?? []
      return h('div', { className: 'bt-social-add', 'data-flybot': 'add-friend' },
        h('div', { className: 'fs-face-head' },
          h('div', { className: 'fs-label fs-label-plain' }, 'Add friend'),
          onDone ? h('button', { type: 'button', className: 'fs-btn fs-btn-sm', onClick: onDone }, 'Done') : null),
        me ? h('div', { className: 'fs-hint', 'data-flybot': 'my-handle', style: { padding: '0 10px' } }, `You are ${me}`) : null,
        h('form', { onSubmit: join, className: 'fs-card bt-social-join' },
          // The paste box takes the full width on its own row, so the start of a link stays readable (#343).
          h('input', { className: 'fs-input', style: { flex: '0 0 auto', width: '100%', boxSizing: 'border-box' }, value: code, placeholder: 'Paste invite link or code', 'aria-label': 'Invite link or code', onChange: e => setCode(e.target.value) }),
          h('div', { className: 'fs-line' },
            h('button', { type: 'submit', className: 'fs-btn', disabled: busy || !code.trim() }, 'Accept invite')),
          // Accepting grants only the invited Bot to you. The Bot you talk through is not shared, so
          // there is nothing to pick with one Bot (#228).
          mine.length > 1 ? h('label', { className: 'fs-line fs-hint fs-join-as', 'data-flybot': 'join-as', title: "Talks for you. Not shared: your friend can't use it unless you invite them to it." },
            h('span', { className: 'fs-join-as-label', 'data-flybot': 'talk-through' }, 'Talk through '),
            h('select', { className: 'fs-input', value: joiner, 'aria-label': 'Which of your Bots talks', onChange: e => setJoiner(e.target.value) },
              mine.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))) : null),
        // Inviting is its own named line: which Bot the link shares is always said, and the link is shown once made.
        h('div', { className: 'fs-line', style: { padding: '4px 10px 0' }, 'data-flybot': 'invite-line' },
          mine.length > 1 ? h('select', { className: 'fs-input', value: sharing, 'aria-label': 'Which of your Bots to share', 'data-flybot': 'share-bot', onChange: e => { setSharing(e.target.value); setMade(null) } },
            mine.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))) : null,
          (() => {
            const label = `Invite a friend to ${(mine.find(bot => bot.id === sharing) ?? mine.find(bot => bot.isMain) ?? mine[0])?.name || 'your Bot'}`
            // A long Bot name shrinks the button with an ellipsis instead of being clipped by the sidebar, so the picker stays usable.
            return h('button', { type: 'button', className: 'fs-btn', 'data-flybot': 'mint-invite', title: label, style: { flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }, disabled: busy, onClick: mint }, label)
          })()),
        made ? h('div', { className: 'fs-line', style: { padding: '2px 10px 0' } },
          h('input', { className: 'fs-input', readOnly: true, value: made.link, 'aria-label': `Invite link for ${made.botName}`, 'data-flybot': 'invite-link', onFocus: e => e.target.select?.(), onClick: e => e.target.select?.() })) : null,
        status ? h('div', { className: 'fs-status', role: 'status', 'data-tone': status.tone, style: { padding: '2px 10px' } }, status.text) : null,
        incoming.length ? h('div', { className: 'bt-social-requests' },
          h('div', { className: 'fs-label' }, 'Friend requests', h('span', { className: 'fs-count' }, String(incoming.length))),
          incoming.map(item => h('div', { key: item.relationshipId, className: 'fs-row bt-social-row' },
            h(FaceAvatar, { bot: faceLook({ member: { handle: item.handle, displayName: item.name } }), size: 24 }),
            h('span', { className: 'fs-text' },
              h('span', { className: 'fs-name' }, item.name ?? item.handle),
              h('span', { className: 'fs-sub' }, item.handle),
              item.message ? h('span', { className: 'fs-sub fs-msg' }, item.message) : null),
            h('span', { className: 'fs-actions' },
              h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: busy, onClick: () => respond(item, 'accept') }, 'Accept'),
              h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: busy, onClick: () => respond(item, 'decline') }, 'Decline'))))) : null,
        outgoing.length ? h('div', { className: 'bt-social-outgoing' },
          h('div', { className: 'fs-label' }, 'Waiting for them to accept'),
          outgoing.map(item => h('div', { key: item.relationshipId ?? item.handle, className: 'fs-row' },
            h(FaceAvatar, { bot: faceLook({ member: { handle: item.handle, displayName: item.name } }), size: 24 }),
            h('span', { className: 'fs-text' },
              h('span', { className: 'fs-name' }, item.name ?? item.handle),
              item.name ? h('span', { className: 'fs-sub' }, item.handle) : null),
            h('span', { className: 'fs-tag' }, 'pending')))) : null)
    }

    // Which local Bots can be invited to (social/status), cached for the synchronous canInvite.
    let status = { at: 0, value: null }
    let statusTask
    const statusListeners = new Set()
    const loadStatus = () => {
      statusTask ??= call('social/status', {}).then(value => {
        const changed = JSON.stringify(value) !== JSON.stringify(status.value)
        status = { at: Date.now(), value }
        if (changed) for (const fn of [...statusListeners]) { try { fn() } catch (error) { console.error('flybot-social: status listener failed', error) } }
        return value
      }).finally(() => { statusTask = undefined })
      return statusTask
    }
    // Fires when what canInvite answers may have changed (first status, connect/disconnect, Bots added).
    const onStatusChange = (fn) => { statusListeners.add(fn); return () => statusListeners.delete(fn) }
    // Sync: true when Bot Social is connected and botId is one of this team's Bots. Until the first
    // status answer it is false (and starts loading); the cache refreshes every 30 s.
    function canInvite(botId) {
      if (Date.now() - status.at > 30_000) void loadStatus().catch(() => {})
      return Boolean(status.value?.connected && status.value.bots.some(bot => bot.id === botId))
    }

    const ACCESS_POLL_MS = 5000
    const ACCESS_NOTE = 'One person per grant. Revoke anyone without affecting the rest. Default: nobody, Chief included.'
    function ManageAccess({ bot }) {
      const [view, setView] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const load = async () => {
        if (!bot?.id) return
        try {
          const next = await call('social/access', { botId: bot.id })
          setView(previous => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
          setError('')
        } catch (e) { setError(errorText(e)) }
      }
      // A friend who accepts while this page is open shows up without reopening it (#228).
      useEffect(() => {
        void load()
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) void load() }, ACCESS_POLL_MS)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [bot?.id])
      if (!bot?.id) return null
      const revoke = async (grant) => {
        setBusy(grant.id)
        setError('')
        try {
          setView(await call('social/revoke-grant', { botId: bot.id, grantId: grant.id, relationshipId: grant.relationshipId, grantee: grant.grantee }))
          const next = await call('social/access', { botId: bot.id })
          setView(next)
        } catch (e) { setError(errorText(e)) }
        finally { setBusy('') }
      }
      const grants = view?.grants ?? []
      return h('div', { className: 'fs fs-card', 'data-flybot': 'manage-access' },
        h('div', { className: 'fs-name' }, 'People with access'),
        h('div', { className: 'fs-hint fs-face-note' }, ACCESS_NOTE),
        grants.length === 0 ? h('div', { className: 'fs-hint' }, 'Nobody has this Bot yet. Invite a friend to grant it.') : null,
        grants.map(grant => h('div', { key: grant.id || grant.grantee, className: 'fs-line', 'data-flybot': 'access-grant' },
          h('div', { className: 'fs-col' },
            h('span', { className: 'fs-name' }, grant.name || grant.grantee),
            grant.home && grant.name && !String(grant.name).includes(grant.home)
              ? h('span', { className: 'fs-sub' }, grant.home)
              : null,
            (grant.rooms ?? []).length ? h('span', { className: 'fs-hint' }, `In use: ${(grant.rooms ?? []).map(room => room.name || room.id).join(', ')}`) : null),
          h('button', {
            type: 'button', className: 'fs-btn', disabled: Boolean(busy),
            'data-flybot': 'revoke-grant', 'aria-label': `Revoke ${grant.name || grant.grantee}`,
            onClick: () => revoke(grant),
          }, busy === grant.id ? 'Revoking…' : 'Revoke'))),
        (view?.rooms ?? []).filter(room => room.origin === 'face-to-face').length
          ? h('div', { className: 'fs-hint' }, `This room only: ${(view.rooms ?? []).filter(room => room.origin === 'face-to-face').map(room => room.name || room.id).join(', ')}`)
          : null,
        error ? h('div', { className: 'fs-status', 'data-tone': 'error', role: 'status' }, error) : null)
    }

    function FriendChatSettings({ bot, actions } = {}) {
      const remote = bot?.remote
      const home = remote?.home
      const handle = remote?.handle
      const [auto, setAuto] = useState(false)
      const [saving, setSaving] = useState(false)
      const [busy, setBusy] = useState(false)
      const [asking, setAsking] = useState(false)
      const [error, setError] = useState('')
      useEffect(() => {
        if (!home) return undefined
        call('social/settings', {}).then(value => setAuto(value?.autoAccept?.[home] === true), () => {})
      }, [home])
      if (!handle) return null
      const toggleAuto = async (on) => {
        if (!home) return
        setSaving(true)
        setAuto(on)
        setError('')
        try {
          const result = await call('social/auto-accept', { home, on })
          setAuto(result?.autoAccept === true)
        } catch (e) {
          setError(errorText(e))
          setAuto(!on)
        } finally { setSaving(false) }
      }
      const who = remote.homeName || remote.owner || home || 'Your friend'
      // Asked inline, like Leave on a face room (#230), not with the browser's confirm box.
      const removeBot = async () => {
        setAsking(false)
        setBusy(true)
        setError('')
        try {
          // social/hide-remote already leaves every room holding this Bot; a second
          // removal from here would race it and show "not in the room" after a good Remove.
          await call('social/hide-remote', { handle })
          actions?.closeSettings?.()
          actions?.closeOverlay?.()
        } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
      }
      return h('div', { className: 'fs fs-friend-settings', 'data-flybot': 'friend-chat-settings' },
        // Auto-send covers every message from your Bots to this friend's Bots (#230 names the pair).
        // The box holds the setting only; the destructive link sits apart, below it (#274).
        h('div', { className: 'fs-card fs-friend-auto', 'data-flybot': 'friend-auto-box' },
          h('label', { className: 'fs-auto', title: AUTO_SEND_NOTE, 'data-flybot': 'friend-auto-send' },
            h('input', { type: 'checkbox', checked: auto === true, disabled: saving || !home, onChange: e => toggleAuto(e.target.checked) }),
            `Auto-send to ${who}`)),
        h('div', { className: 'fs-friend-remove', 'data-flybot': 'friend-remove-row' }, asking
          ? h('span', { className: 'fs-leave-ask', 'data-flybot': 'remove-friend-bot-confirm' },
            h('span', { className: 'fs-hint' }, `Remove ${bot.name}? ${who} can share it again.`),
            h('button', { type: 'button', className: 'fs-btn fs-btn-sm', 'data-flybot': 'remove-friend-bot-yes', onClick: () => { void removeBot() } }, 'Remove'),
            h('button', { type: 'button', className: 'fs-btn fs-btn-sm', 'data-flybot': 'remove-friend-bot-no', onClick: () => setAsking(false) }, 'Keep'))
          : h('button', {
            type: 'button',
            className: 'fs-link',
            'data-flybot': 'remove-friend-bot',
            title: 'Remove this Bot from your list and from your groups. This does not unfriend the owner.',
            'aria-label': busy ? 'Removing…' : 'Remove this Bot',
            'aria-busy': busy || undefined,
            disabled: !!busy,
            onClick: () => setAsking(true),
          }, busy ? 'Removing…' : 'Remove this Bot')),
        error ? h('div', { className: 'fs-status', 'data-tone': 'error', role: 'status' }, error) : null)
    }

    function BotSocialDetails({ bot, actions } = {}) {
      useStyles()
      if (bot?.remote) {
        return h('div', { 'data-flybot': 'bot-social-details' },
          h(FriendChatSettings, { bot, actions }))
      }
      return h('div', { className: 'fs-sharing', 'data-flybot': 'bot-social-details' },
        h('div', { className: 'fs-label' }, 'Sharing'),
        h(InviteToBot, { bot }),
        h(ManageAccess, { bot }))
    }

    // In a Bot's settings: invite a friend to this Bot.
    function InviteToBot({ bot }) {
      useStyles()
      const [invite, setInvite] = useState(null)
      const [note, setNote] = useState(null)
      const [busy, setBusy] = useState(false)
      if (!bot?.id) return null
      const create = async () => {
        setBusy(true); setNote(null)
        try { setInvite(await call('social/create-invite', { botId: bot.id })) } catch (e) { setNote({ tone: 'error', text: errorText(e) }) } finally { setBusy(false) }
      }
      // Called straight from the click, so the clipboard write keeps its permission.
      const copy = text => {
        const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
        if (clip?.writeText) clip.writeText(text).then(() => setNote({ tone: 'ok', text: 'Copied.' }), () => setNote({ tone: 'error', text: 'Could not copy. Select the link and copy it by hand.' }))
      }
      // The link first, then Copy link as the one primary action; a new link is a quiet text button (#230).
      return h('div', { className: 'fs fs-card', 'data-flybot': 'invite-to-bot' },
        h('div', { className: 'fs-hint' }, `Invite grants ${bot.name} only. Revoke anytime in People with access.`),
        invite ? null : h('button', { type: 'button', className: 'fs-btn', disabled: busy, onClick: create }, 'Invite to this Bot'),
        invite ? h('input', { className: 'fs-input fs-invite-link', readOnly: true, value: invite.link, 'aria-label': 'Invite link', onFocus: e => e.target.select() }) : null,
        invite ? h('div', { className: 'fs-line fs-invite-actions' },
          h('button', { type: 'button', className: 'fs-btn fs-btn-primary fs-btn-fit', 'data-flybot': 'copy-link', onClick: () => copy(invite.link) }, 'Copy link'),
          h('button', { type: 'button', className: 'fs-btn', 'data-flybot': 'copy-invite-text', onClick: () => copy(invite.text) }, 'Copy with instructions'),
          h('button', { type: 'button', className: 'fs-link fs-invite-new', 'data-flybot': 'new-invite-link', disabled: busy, onClick: create }, 'New link')) : null,
        note ? h('div', { className: 'fs-status', 'data-tone': note.tone }, note.text) : null)
    }

    const SocialPageIcon = () => h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true },
      h('circle', { cx: 8, cy: 8, r: 6 }), h('path', { d: 'M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12' }))

    // Settings → Bot Social (#337): the server this FlyBot talks to. `t` is the host's translator (zh in a zh UI),
    // `Section` / `Row` the host's Settings layout, so the page looks like Connectors.
    const STATE_TEXT = {
      connected: (t, view) => (view.handle ? t('Connected as {handle}', { handle: view.handle }) : t('Connected')),
      connecting: t => t('Connecting…'),
      'not-configured': t => t('No server set. Friends and sharing are off until you set one.'),
      error: (t, view) => t('Could not connect: {error}', { error: view.error ?? '' }),
    }
    const serverHost = (address) => { try { return new URL(address).host } catch { return String(address ?? '') } }
    function SocialServerSettings({ t: given, Section, Row } = {}) {
      useStyles()
      const t = given ?? ((text, params) => String(text).replace(/\{(\w+)\}/g, (_, key) => String(params?.[key] ?? '')))
      const [view, setView] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [live, setLive] = useState(null)
      const [form, setForm] = useState(false)
      const [address, setAddress] = useState('')
      const [name, setName] = useState('')
      const [checked, setChecked] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const refresh = async () => {
        try { setView(await call('social/server', {})); setLoadError(null) } catch (e) { setLoadError(errorText(e)) }
      }
      useEffect(() => { void refresh() }, [])
      // A server that is still connecting is read again until it settles.
      useEffect(() => {
        if (view?.state !== 'connecting' || typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => { void refresh() }, 2000)
        return () => clearInterval(timer)
      }, [view?.state])
      // What the current server lists, read once the page shows it.
      useEffect(() => {
        if (!view?.server || view.state === 'not-configured') return undefined
        let off = false
        call('social/server-check', {}).then(info => { if (!off) setLive({ ok: true, ...info }) }, e => { if (!off) setLive({ ok: false, error: errorText(e) }) })
        return () => { off = true }
      }, [view?.server, view?.state === 'connected'])
      const platform = live?.ok ? live : view?.platform
      const open = (value = '') => { setForm(true); setAddress(value); setChecked(null); setError(null) }
      const close = () => { setForm(false); setChecked(null); setError(null); setBusy(false) }
      const check = async (value = address) => {
        setBusy(true); setError(null); setChecked(null)
        try { setChecked(await call('social/server-check', { server: value })); setAddress(value) } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
      }
      const change = async () => {
        setBusy(true); setError(null)
        try {
          setView(await call('social/server-set', { server: checked.server, displayName: name.trim() || undefined, confirm: true }))
          setLive(null)
          close()
        } catch (e) { setError(errorText(e)); void refresh() } finally { setBusy(false) }
      }
      if (!view) return h('div', { className: 'fs-status', 'data-tone': loadError ? 'error' : undefined, 'data-flybot': 'social-server' }, loadError ?? t('Loading…'))
      const source = view.source === 'settings' ? t('Set here') : view.source === 'config' ? t('Profile default') : t('Not set')
      const status = (STATE_TEXT[view.state] ?? STATE_TEXT.connecting)(t, view)
      const quick = [...(view.defaultServer && view.source === 'settings' ? [view.defaultServer] : []), ...view.known].filter((item, at, all) => all.indexOf(item) === at)
      return h('div', { 'data-flybot': 'social-server' },
        h(Section, { title: t('Bot Social server') },
          h(Row, { label: view.server ?? t('No server'), hint: status },
            h('span', { className: 'fs-tag' }, source),
            view.canChange && !form ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'data-flybot': 'server-change', onClick: () => open() }, t('Change server')) : null),
          platform ? h(Row, { label: t('Features'), hint: platform.features?.length ? platform.features.join(', ') : t('No optional features listed.') }, null) : null,
          live && !live.ok ? h(Row, { label: t('Reachability'), hint: live.error }, null) : null,
          !view.canChange ? h(Row, { label: t('Read-only'), hint: t('Another FlyBot window holds this team. Change the server there.') }, null) : null),
        form ? h(Section, { title: t('Switch server') },
          h('div', { className: 'fs-srv-form' },
            h('input', { className: 'bt-input', value: address, spellCheck: false, autoFocus: true, 'aria-label': t('Server address'), placeholder: 'https://social.example', 'data-flybot': 'server-address', onChange: e => { setAddress(e.target.value); setChecked(null); setError(null) }, onKeyDown: e => { if (e.key === 'Enter' && address.trim() && !busy) void check() } }),
            quick.length ? h('div', { className: 'fs-srv-quick' }, h('span', { className: 'bt-set-hint' }, t('Used before:')), quick.map(item => h('button', { key: item, type: 'button', className: 'fs-link', onClick: () => { setAddress(item); void check(item) } }, item === view.defaultServer ? t('{host} (profile default)', { host: serverHost(item) }) : serverHost(item)))) : null,
            h('input', { className: 'bt-input', value: name, spellCheck: false, 'aria-label': t('Name for your home (optional)'), placeholder: t('Name for your home (optional)'), maxLength: 40, onChange: e => setName(e.target.value) }),
            checked ? h('div', { className: 'fs-srv-checked', 'data-flybot': 'server-checked' },
              h('div', { className: 'fs-status' }, `${checked.name}${checked.version ? ` ${checked.version}` : ''} · ${serverHost(checked.server)}`),
              h('div', { className: 'fs-status' }, checked.features?.length ? `${t('Features')}: ${checked.features.join(', ')}` : t('No optional features listed.'))) : null,
            checked && !checked.same ? h('div', { className: 'fs-srv-warn', role: 'alert', 'data-flybot': 'server-warning' },
              h('strong', null, t('Switching servers changes who you are')),
              h('span', null, checked.known ? t('You used this server before. Your saved identity, friends and settings for it come back.') : t('You get a new identity on this server. The friends and sharing you have now stay on the current server; they do not move.')),
              h('span', null, t('Your current sign-in is kept as a backup on this computer and is never deleted. Switch back any time.')),
              h('span', null, t('Your Bots stop being shared with friends until you share them again on the new server.'))) : null,
            checked && checked.same ? h('div', { className: 'fs-status' }, t('This is the server you already use.')) : null,
            error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null,
            h('div', { className: 'fs-srv-actions' },
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: close }, t('Cancel')),
              checked && !checked.same
                ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, 'data-flybot': 'server-confirm', onClick: () => void change() }, busy ? t('Switching…') : t('Switch to this server'))
                : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || address.trim() === '', 'data-flybot': 'server-check', onClick: () => void check() }, busy ? t('Checking…') : t('Check')))))
          : null)
    }

    let cache = { at: 0, list: [] }
    const friendRows = async (query) => {
      if (Date.now() - cache.at > 30_000) cache = { at: Date.now(), list: await call('social/friends', {}) }
      const needle = query.trim().toLowerCase().replace(/^@/, '')
      return cache.list
        .filter(friend => friend.handle.includes(needle) || String(friend.name).toLowerCase().includes(needle))
        // The inserted text asks the Bot to use message_friend_bot; the send is held for approval.
        .map(friend => ({ name: `${friend.name} · remote`, description: `${friend.handle} · ${friend.home}`, section: 'Friends\' Bots', value: `${friend.handle} ` }))
    }

    return {
      name: 'flybot-social',
      inject: [],
      errorText,
      canInvite,
      InviteToBot,
      ManageAccess,
      BotSocialDetails,
      SocialServerSettings,
      AddFriend,
      PendingApprovals,
      ChatApproval,
      holdReasonLine,
      listedFriendChat,
      ChatApprovalDock,
      approvalsForOpenChat,
      localHoldView,
      friendLabel,
      MyHandle,
      FaceRoomStatus,
      PeerThinking,
      thinkingLine,
      thinkingNames,
      FriendBotRow,
      FriendChatSettings,
      FaceToFaceGroup,
      FaceAvatar,
      FaceRoomOverview,
      FaceRoomCard,
      FaceRooms,
      FaceAutoSend,
      ConfirmLeave,
      apply(ctx) {
        let offs = []
        let tries = 0
        // ds-bot's client creates the registry in its apply; wait for it if this loads first.
        const attach = () => {
          if (globalThis.__flybot__ === undefined) {
            if (++tries < 100) timer = setTimeout(attach, 100)
            else console.error('flybot-social: ds-bot FlyBot slots not found')
            return
          }
          offs = [
            slots().register('flybot.sidebar.section', { id: 'social', order: 100, component: FriendsBots }),
            slots().register('flybot.new-chat.action', {
              id: 'social-face-group',
              order: 15,
              label: 'Face-to-face group',
              hint: 'Meet the people next to you. Pick your Bots and type the same 6-digit number.',
              run: ({ close } = {}) => { openFaceToFace(); close?.() },
            }),
            slots().register('flybot.new-chat.action', {
              id: 'social-add-friend',
              order: 16,
              label: 'Add friend',
              hint: 'Paste an invite link or code.',
              run: ({ close } = {}) => { openAddFriend(); close?.() },
            }),
            slots().register('flybot.composer.mention', { id: 'social', order: 100, candidates: friendRows }),
            (() => { try { return slots().register('flybot.account.header', { id: 'social-handle', order: 10, component: MyHandle }) } catch { return () => {} } })(),
            slots().register('flybot.bot.details', { id: 'social-invite', order: 100, component: BotSocialDetails }),
            slots().register('flybot.settings.page', { id: 'social', order: 100, label: 'Bot Social', icon: SocialPageIcon, component: SocialServerSettings }),
            slots().register('flybot.room.overview', { id: 'social-face', order: 50, component: FaceRoomOverview }),
            slots().register('flybot.session.dock', { id: 'social-room-end', order: 40, component: FaceRoomStatus }),
            slots().register('flybot.session.dock', { id: 'social-approval', order: 50, policy: 'social', component: ChatApprovalDock }),
            slots().register('flybot.session.dock', { id: 'social-thinking', order: 60, component: PeerThinking }),
          ]
          // For other plugins (the tree's per-node "Copy invite link"): ctx.flybot.social.canInvite(botId)
          // is synchronous; flybot.call('social.createInvite', { botId }) returns { link, text, ... }.
          const social = { canInvite, onChange: onStatusChange, createInvite: botId => call('social.createInvite', { botId }), openFaceToFace, openAddFriend }
          globalThis.__flybot__.social = social
          if (globalThis.__flybot__.api) globalThis.__flybot__.api.social = social
          offs.push(() => {
            if (globalThis.__flybot__?.social === social) delete globalThis.__flybot__.social
            if (globalThis.__flybot__?.api?.social === social) delete globalThis.__flybot__.api.social
          })
          void loadStatus().catch(() => {})
          // Keep canInvite current (and onChange firing) without callers polling.
          if (typeof setInterval === 'function') {
            const statusTimer = setInterval(() => { void loadStatus().catch(() => {}) }, 30_000)
            statusTimer?.unref?.() // node tests: never keeps the process alive
            offs.push(() => clearInterval(statusTimer))
          }
        }
        let timer
        attach()
        const dispose = () => {
          clearTimeout(timer)
          for (const off of offs.splice(0)) off()
        }
        ctx?.effect?.(() => dispose, 'flybot-social: slots')
        return dispose
      },
    }
  },
})
