// Render smoke only, not browser effects, layout or interaction acceptance.
import assert from 'node:assert/strict'
import {createElement} from 'react'
import {renderToString} from 'react-dom/server'
import {App,routes} from './render-check.mjs'
for (const initialRoute of routes) for (const initialLocked of [false,true]) for (const initialLang of ['zh','en']) {
 const html=renderToString(createElement(App,{initialRoute,initialLocked,initialLang}))
 assert.match(html,/MOCK HOST/)
 console.log('PASS source-component server render',initialRoute,initialLocked,initialLang,html.length)
}
