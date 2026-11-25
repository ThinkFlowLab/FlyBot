// Workbook data lives with other private artifacts in the owner’s DS-Bot.
import { validLongText } from '../../featurekit/http.js'

export const WORKBOOK_SCHEMA = 'flybot-workspace.spreadsheet.v1'
export const WORKBOOK_LIMITS = {sheets:8,rows:200,columns:26,cell:500}
export const emptyWorkbook = () => ({schema:WORKBOOK_SCHEMA,sheets:[{name:'Sheet1',rows:[]}]})

export function normalizeWorkbook(value) {
  if (!value || value.schema !== WORKBOOK_SCHEMA || !Array.isArray(value.sheets)
      || value.sheets.length < 1 || value.sheets.length > WORKBOOK_LIMITS.sheets) return null
  const names = new Set()
  const sheets = []
  for (const item of value.sheets) {
    const name = typeof item?.name === 'string' ? item.name.trim() : ''
    if (!name || name.length > 31 || /[\[\]:*?\/\\\u0000-\u001f]/.test(name)
        || name.startsWith("'") || name.endsWith("'") || names.has(name.toLowerCase())
        || !Array.isArray(item.rows) || item.rows.length > WORKBOOK_LIMITS.rows) return null
    names.add(name.toLowerCase())
    const rows = []
    for (const cells of item.rows) {
      if (!Array.isArray(cells) || cells.length > WORKBOOK_LIMITS.columns
          || !cells.every(cell => validLongText(cell,WORKBOOK_LIMITS.cell))) return null
      rows.push([...cells])
    }
    sheets.push({name,rows})
  }
  const workbook = {schema:WORKBOOK_SCHEMA,sheets}
  return JSON.stringify(workbook).length <= 280_000 ? workbook : null
}

export function decodeWorkbook(raw) {
  try { return normalizeWorkbook(JSON.parse(raw)) } catch { return null }
}

export function workbookText(workbook) {
  return workbook.sheets.map(({name,rows}) => [name, ...rows.map(row => row.join('\t'))].join('\n')).join('\n\n')
}

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/
const CELL = '[A-Z](?:[1-9]\\d?|1\\d{2}|200)'
const FORMULA = new RegExp(`^(?:SUM|AVERAGE|MIN|MAX|COUNT)\\(${CELL}:${CELL}\\)$`)

export function spreadsheetCell(value) {
  if (value.startsWith('=') && FORMULA.test(value.slice(1).toUpperCase())) return {formula:value.slice(1).toUpperCase()}
  if (value.length <= 15 && NUMBER.test(value)) return {number:value}
  return {text:value}
}
