// DSH is absent: these marked dependency substitutes are NOT renderer acceptance.
import { createElement as h } from 'react'
export const MarkdownText = ({text}) => h('pre', {'data-fixture-mock':'DSH MarkdownText', style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}, text)
export const FishLogo = () => h('span', {'data-fixture-mock':'DSH FishLogo', 'aria-label':'FlyBot mock logo'}, '◈')
export const projectUserText = text => ({text:String(text ?? ''), images:[], attachments:[]})
