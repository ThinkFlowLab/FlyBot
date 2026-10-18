// A fake adapter for the keyless tests: an in-memory app that can be broken on purpose.
// It implements the whole contract of docs/interop/live-e2e-adapter.md so the scenario
// logic runs exactly as it does against FlyBot's web UI — minus the browser, the model
// and any network.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const fixtureCsv = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'orders.csv'))

const paidJson = rows => {
  const orders = rows.filter(row => row.status === 'paid')
  return `${JSON.stringify({ orders, count: orders.length, total: orders.reduce((sum, row) => sum + row.amount, 0) }, null, 2)}\n`
}

export class FakeAdapter {
  constructor({ breakIds, mutateSummary, stalePreview, neverSettle } = {}) {
    this.files = new Map([['orders.csv', fixtureCsv()]])
    this.conversation = []
    this.delivered = []
    this.breakIds = breakIds
    this.mutateSummary = mutateSummary
    this.stalePreview = stalePreview
    this.neverSettle = neverSettle
  }

  async uploadFile(name, bytes) { this.files.set(name, bytes) }

  async sendTask(text) {
    this.conversation.push({ who: 'user', text })
    this.conversation.push({ who: 'app', text: '好的，我来处理。' })
    if (this.neverSettle) return
    const rows = this.files.get('orders.csv').toString('utf8').split('\n').slice(1).filter(Boolean)
      .map(line => { const [order_id, region, status, amount] = line.split(',').map(cell => cell.trim()); return { order_id, region, status, amount: Number(amount) } })
    if (!this.files.has('summary.json')) {
      const paid = rows.filter(row => row.status === 'paid')
      if (this.breakIds) paid[0].order_id = 'A099'
      this.files.set('summary.json', Buffer.from(paidJson(paid)))
      this.delivered.push('summary.json')
      this.conversation.push({ who: 'app', text: '已生成 summary.json。' })
    } else if (!this.files.has('summary-east.json')) {
      if (this.mutateSummary) this.files.set('summary.json', Buffer.from(`${paidJson(rows.filter(row => row.status === 'paid'))}// touched\n`))
      const east = rows.filter(row => row.status === 'paid' && row.region === '华东')
      this.files.set('summary-east.json', Buffer.from(paidJson(east)))
      this.delivered.push('summary-east.json')
      this.conversation.push({ who: 'app', text: '已生成 summary-east.json。' })
    }
  }

  async settle() { if (this.neverSettle) throw new Error('the team did not settle within 1 ms') }

  async deliveredFileNames() { return [...this.delivered] }

  async readFile(name) { return this.files.get(name) }

  async openPreview(name) { return this.stalePreview && name === 'summary.json' ? '{"orders": [], "count": 0, "total": 0}' : this.files.get(name)?.toString('utf8') ?? '' }

  async reload() { this.reloaded = true }

  async conversationLines() { return this.conversation.map(line => ({ ...line })) }

  async screenshot() { this.shots = (this.shots ?? 0) + 1 }
}
