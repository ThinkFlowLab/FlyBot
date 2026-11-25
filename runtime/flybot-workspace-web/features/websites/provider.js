import { BODY_MAX, TITLE_MAX, validBody, validTitle } from '../artifacts/model.js'

const RESPONSE_MAX = 20_000
const HTML_DOCUMENT = /^(?:<!doctype html>\s*)?<html(?:\s[^>]*)?>[\s\S]*<\/html\s*>$/i

export async function generateWebsite(runtime, prompt) {
  const response = await runtime.backgroundTextOnly([
    'Build a responsive and usable website for the description below.',
    'Return only a JSON object with two string fields, "title" and "html".',
    `Use a title in the language of the description, up to ${TITLE_MAX} characters.`,
    `Use one complete <!doctype html> document with <html>, <head> and <body>, up to ${BODY_MAX} characters.`,
    'Use inline CSS and vanilla JavaScript. Make the requested controls work in the page.',
    'Use only local browser state or sample data. No external assets, dependencies, network requests, or credentials.',
    'Description: ' + JSON.stringify(prompt),
  ].join('\n'))
  if (typeof response !== 'string' || response.length > RESPONSE_MAX) throw new Error('Invalid website draft')
  const parsed = JSON.parse(response.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'))
  const { title, html } = parsed ?? {}
  if (!validTitle(title) || !validBody(html) || !HTML_DOCUMENT.test(html.trim())) {
    throw new Error('Invalid website draft')
  }
  return { title: title.trim(), body: html.trim() }
}
