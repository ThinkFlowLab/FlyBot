// Phone-width layout, step 1 (#362): at about 400px a phone browser can skim a chat, press
// Approve / Reject on a held reply and work the Agent inbox. Only these surfaces change;
// the shell keeps its own icon rail (DSH collapses the sidebar below 1024px; the floating
// cards stay clear of its 56px, so the top + and the account stay reachable), and the inbox
// dialog already fills the screen at this width (styles.js). Installed after the shell
// group's other styles, so these rules win at equal specificity. No PWA, push or native
// app here: they come after #352, and a notification will only ever open the card.
export const MOBILE_MAX_WIDTH = 640

export const MOBILE_CSS = `
@media (max-width:${MOBILE_MAX_WIDTH}px){
.bt-held-actions{max-width:100%}
.bt-held-card{padding:10px 12px}
:is(.bt-held-card,.bt-flybot-approval) .bt-flybot-approval-actions{gap:8px;margin-top:8px}
:is(.bt-held-card,.bt-flybot-approval) .bt-flybot-approval-actions>button{flex:1 1 0;min-width:0;height:40px;padding:0 16px;border-radius:999px;border:0;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:14px;font-weight:500;cursor:pointer}
:is(.bt-held-card,.bt-flybot-approval) .bt-flybot-approval-actions>button.bt-flybot-approve{background:var(--bt-accent);color:var(--bt-accent-ink,#fff);font-weight:600}
:is(.bt-held-card,.bt-flybot-approval) .bt-flybot-approval-actions>button:disabled{opacity:.5;cursor:default}
.bt-held-retry{min-height:32px}
.bt-flybot-approvals{left:64px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom,0px));max-width:none;max-height:min(60vh,calc(100vh - 16px))}
.bt-flybot-pointers{top:8px;right:8px;max-width:calc(100vw - 72px)}
.bt-flybot-pointer{max-width:100%;min-width:0}
.bt-flybot-pointer-text{flex:0 1 auto;min-width:0;max-width:none}
.bt-flybot-pointer-note{flex:0 100 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.bt-flybot-pointer button{flex:none;min-height:28px;padding:4px 12px}
.bt-inbox-card{flex-wrap:wrap;row-gap:8px}
.bt-inbox-copy{flex-basis:calc(100% - 38px)}
.bt-inbox-title,.bt-inbox-reason{white-space:normal;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.bt-inbox-actions{flex:1 1 100%;justify-content:flex-end;flex-wrap:wrap;padding-left:38px}
.bt-inbox-actions :is(.bt-soft,.bt-send){height:36px;padding:0 16px;font-size:13px}
}
`
