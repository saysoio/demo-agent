// /game/: the pot, the security layer, the stopped tricks, the submit form and the live feed. Everything players or
// the model wrote is set with textContent, never as HTML.
const $ = id => document.getElementById(id)
const OUTCOME = {
  paid: ['paid', 'ok'], blocked: ['stopped by Sayso', 'stop'], asked: ['held for owner', 'hold'], skipped: ['ignored', 'quiet'],
  invalid: ['nothing to pay', 'quiet'], unavailable: ['not signed (no answer)', 'quiet'], error: ['not sent', 'quiet'], paused: ['game paused', 'quiet'],
}
const CHANNEL = { chat: 'team chat' }
// which of Sayso's checks stopped it: a client-side allowlist of labels, so an unknown value shows nothing
const RULE = { cap: 'over a cap', 'unknown payee': 'unknown payee', injection: 'injection', judge: 'judge' }
// the server's limits, sent with the pot; these match it until the first answer
let limits = { textChars: 600, feedPage: 50 }
let unit = '', explorerBase = '', oldest = null, newest = 0
// the feed shows this many newest rows until "Show all"
const FEED_SHORT = 5
let expanded = false, hasOlder = false
const shown = new Map()
// ids shown as queued or thinking: followed by id once they fall off the newest page
const waiting = new Set()

const short = a => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '')
const ago = t => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago` }
const get = path => fetch(path, { headers: { accept: 'application/json' } }).then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))

// a line like "Sayso: reason", the label in its own span; both parts as text
function labelled(el, label, text) {
  el.replaceChildren()
  if (!text) return
  if (label) { const b = document.createElement('span'); b.className = 'lab'; b.textContent = `${label}: `; el.append(b) }
  el.append(document.createTextNode(text))
}

function render(a) {
  const li = shown.get(a.id) ?? $('row').content.firstElementChild.cloneNode(true)
  let tone
  li.querySelector('.who').textContent = a.source === 'vendor' ? `vendor · ${a.handle}` : `@${a.handle}`
  li.querySelector('.chan').textContent = CHANNEL[a.channel] ?? a.channel
  const time = li.querySelector('time'); time.dateTime = new Date(a.createdAt).toISOString(); time.textContent = ago(a.createdAt)
  li.querySelector('.body').textContent = a.body
  const badge = li.querySelector('.badge'), what = li.querySelector('.what')
  li.querySelector('.rule').textContent = a.status === 'done' && Object.hasOwn(RULE, a.rule) ? RULE[a.rule] : ''
  if (a.status !== 'done') {
    const thinking = a.status === 'thinking'
    tone = 'wait'
    badge.textContent = thinking ? 'thinking' : 'in line'; badge.className = `badge wait${thinking ? ' thinking' : ''}`; what.textContent = ''
  } else {
    const [label, t] = a.win ? ['POT BROKEN', 'win'] : OUTCOME[a.outcome] ?? [a.outcome, 'quiet']
    tone = t === 'win' ? 'stop' : t
    badge.textContent = label; badge.className = `badge ${t}`
    what.textContent = a.action === 'pay' && a.toAddr ? `tried ${a.amount} ${unit} to ${short(a.toAddr)}` : ''
    if (a.txHash) {
      const link = document.createElement('a'); link.href = `${explorerBase}/tx/${a.txHash}`
      link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'view tx'
      if (what.textContent) what.append(' · ')
      what.append(link)
    }
  }
  li.className = `item t-${tone} ${a.win ? 'win' : ''} ${a.source}`
  if (a.reason) labelled(li.querySelector('.reason'), 'Sayso', a.reason)
  else labelled(li.querySelector('.reason'), '', a.note ?? '')
  labelled(li.querySelector('.thought'), 'Agent', a.thought ?? '')
  shown.set(a.id, li)
  if (a.status === 'done') waiting.delete(a.id); else waiting.add(a.id)
  return li
}

function forget(id) { shown.get(id)?.remove(); shown.delete(id); waiting.delete(id) }

function setStatus(state) {
  const s = $('status')
  s.className = `status ${state}`
  s.querySelector('.status-t').textContent = state
}

async function loadPot() {
  const p = await get('/api/pot')
  unit = p.unit; explorerBase = p.explorerBase; limits = p.limits
  $('text').maxLength = limits.textChars; $('count-max').textContent = limits.textChars
  $('balance').textContent = p.balance ?? '…'; $('unit').textContent = p.unit
  $('address').textContent = short(p.address); $('explorer').href = `${explorerBase}/address/${p.address}`; $('network').textContent = p.network === 'base' ? 'Base' : 'Base Sepolia (test money)'
  setStatus(p.paused ? 'paused' : 'live')
  const note = $('pause-note')
  note.hidden = !p.paused
  note.textContent = p.budgetPaused ? 'Paused for budget: the agent has used its model budget for today. It is back after midnight UTC.' : p.paused ? 'The game is paused for now.' : ''
  showSource(p.source)
  $('s-attempts').textContent = p.stats.attempts; $('s-blocked').textContent = p.stats.blocked; $('s-wins').textContent = p.stats.wins; $('s-queued').textContent = p.queued
  $('send').disabled = !!p.paused
  const v = $('vendors')
  if (!v.childElementCount) for (const x of p.vendors) {
    const li = document.createElement('li'), n = document.createElement('span'), ad = document.createElement('code')
    n.className = 'v-name'; n.textContent = x.name; ad.className = 'v-addr'; ad.textContent = x.address
    li.append(n, ad); v.append(li)
  }
}

// the link appears only for an https URL the server sends
function showSource(url) {
  const ok = typeof url === 'string' && url.startsWith('https://')
  for (const a of [$('code-link'), $('foot-link')]) if (ok) a.href = url
  $('code-link').hidden = !ok; $('foot-code').hidden = !ok
}

async function loadRules() {
  const r = await get('/api/rules')
  const amt = x => `${x} ${r.unit}`
  const v = $('g-vendors'); v.replaceChildren()
  for (const x of r.vendors) {
    const li = document.createElement('li'), n = document.createElement('span'), ad = document.createElement('code')
    n.textContent = x.name; ad.textContent = short(x.address); ad.title = x.address
    li.append(n, ' ', ad); v.append(li)
  }
  $('g-per').textContent = amt(r.perPayment); $('g-day').textContent = amt(r.daily); $('g-week').textContent = amt(r.weekly)
  $('g-actions').textContent = r.actions.length === 1 && r.actions[0] === 'transfer' ? `Plain ${r.unit} transfers to these payees only. No trades, contract calls, approvals or signed messages.` : r.actions.join(', ')
  $('g-strict').textContent = r.strictness
  $('g-sdk').textContent = `${r.sdk.name} ${r.sdk.version}, ${r.sdk.mode} mode: nothing is signed without Sayso's allow`
  $('g-server').textContent = r.checkServer.replace(/^https:\/\//, '')
  $('g-signed').textContent = r.signedVerdicts ? 'Signed by Sayso, every one; the wallet checks the signature' : 'unsigned'
  $('g-source').textContent = r.source === 'published rules' ? 'Published rules, word for word' : r.source
  $('g-text').textContent = r.text
}

// the stopped tricks: re-rendered only when the set of ids changes
let trickIds = ''
async function loadTricks() {
  const { items } = await get('/api/tricks')
  const ids = items.map(a => a.id).join(',')
  if (ids === trickIds) return
  trickIds = ids
  const list = $('t-list')
  list.replaceChildren(...items.map(trick))
  $('tricks').hidden = !items.length
  list.scrollLeft = 0
  carButtons()
}

function trick(a) {
  const li = $('trick').content.firstElementChild.cloneNode(true)
  li.querySelector('.who').textContent = `@${a.handle}`
  li.querySelector('.chan').textContent = CHANNEL[a.channel] ?? a.channel
  const time = li.querySelector('time'); time.dateTime = new Date(a.createdAt).toISOString(); time.textContent = ago(a.createdAt)
  li.querySelector('.t-body').textContent = a.excerpt
  li.querySelector('.what').textContent = a.toAddr ? `tried ${a.amount} ${unit} to ${short(a.toAddr)}` : ''
  li.querySelector('.rule').textContent = Object.hasOwn(RULE, a.rule) ? RULE[a.rule] : ''
  labelled(li.querySelector('.reason'), 'Sayso', a.reason ?? '')
  return li
}

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches
function carButtons() {
  const l = $('t-list'), end = l.scrollWidth - l.clientWidth - 2
  $('t-prev').disabled = l.scrollLeft <= 2; $('t-next').disabled = l.scrollLeft >= end
}
function carStep(dir) {
  const l = $('t-list'), card = l.firstElementChild
  if (!card) return
  const gap = parseFloat(getComputedStyle(l).columnGap) || 0
  l.scrollBy({ left: dir * (card.getBoundingClientRect().width + gap), behavior: still() ? 'auto' : 'smooth' })
}
$('t-prev').addEventListener('click', () => carStep(-1))
$('t-next').addEventListener('click', () => carStep(1))
$('t-list').addEventListener('scroll', carButtons, { passive: true })
addEventListener('resize', carButtons)

let first = true, feedNote = ''
function feedStatus(text) { if (text !== feedNote) { feedNote = text; $('feed-status').textContent = text } }

// Rows in the newest page's id range that the page no longer returns were hidden by an admin.
function dropHidden(items) {
  const ids = new Set(items.map(a => a.id))
  const floor = items.length < limits.feedPage ? 0 : Math.min(...ids)
  for (const id of [...shown.keys()]) if (id >= floor && !ids.has(id)) forget(id)
}

// Waiting rows older than the newest page: asked for by id, and dropped when hidden.
async function followWaiting(items) {
  const onPage = new Set(items.map(a => a.id))
  const ids = [...waiting].filter(id => !onPage.has(id)).slice(0, limits.feedPage)
  if (!ids.length) return
  const { items: rows } = await get(`/api/feed?ids=${ids.join(',')}`)
  for (const a of rows) render(a)
  const back = new Set(rows.map(a => a.id))
  for (const id of ids) if (!back.has(id)) forget(id)
}

async function loadFeed() {
  const { items } = await get('/api/feed')
  const list = $('feed')
  let added = 0
  dropHidden(items)
  for (const a of [...items].reverse()) {
    const fresh = !shown.has(a.id)
    const li = render(a)
    if (fresh && a.id > newest) { list.prepend(li); if (!first) added++ }
    else if (fresh) list.append(li)
    newest = Math.max(newest, a.id); oldest = oldest === null ? a.id : Math.min(oldest, a.id)
  }
  if (first) { hasOlder = items.length >= limits.feedPage; first = false }
  feedControls()
  await followWaiting(items)
  const busy = waiting.size
  feedStatus(added ? `${added} new` : busy ? `${busy} waiting` : 'Up to date')
}

// Collapsed, the list shows its first FEED_SHORT rows (CSS) and paging back waits for "Show all".
function feedControls() {
  const t = $('toggle')
  t.hidden = shown.size <= FEED_SHORT && !hasOlder
  t.textContent = expanded ? 'Show fewer' : 'Show all'
  t.setAttribute('aria-expanded', String(expanded))
  $('feed').classList.toggle('collapsed', !expanded)
  $('more').hidden = !expanded || !hasOlder
}

$('toggle').addEventListener('click', () => {
  expanded = !expanded
  feedControls()
  if (!expanded) $('feed-h').scrollIntoView({ block: 'nearest', behavior: still() ? 'auto' : 'smooth' })
})

$('more').addEventListener('click', async () => {
  const { items } = await get(`/api/feed?before=${oldest}`)
  for (const a of items) { if (!shown.has(a.id)) $('feed').append(render(a)); oldest = Math.min(oldest, a.id) }
  hasOlder = items.length >= limits.feedPage
  feedControls()
})

$('text').addEventListener('input', () => {
  const n = [...$('text').value].length
  $('count').textContent = n
  $('count-wrap').className = `count${n >= limits.textChars ? ' full' : n >= limits.textChars * 0.9 ? ' near' : ''}`
})
try { $('handle').value = localStorage.getItem('handle') ?? '' } catch { /* storage blocked */ }

$('form').addEventListener('submit', async e => {
  e.preventDefault()
  const msg = $('msg'), btn = $('send')
  const handle = $('handle').value.trim(), text = $('text').value
  const channel = new FormData($('form')).get('channel')
  btn.disabled = true; msg.textContent = 'Sending…'; msg.className = 'msg'
  try {
    const r = await fetch('/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, channel, text }) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error ?? `error ${r.status}`)
    try { localStorage.setItem('handle', handle) } catch { /* storage blocked */ }
    $('text').value = ''; $('count').textContent = '0'; $('count-wrap').className = 'count'
    msg.textContent = `In the inbox (#${j.id}). Watch the feed.`
    loadFeed().catch(() => {})
  } catch (err) { msg.textContent = err.message; msg.className = 'msg bad' } finally { btn.disabled = false }
})

const tick = () => Promise.all([loadPot(), loadFeed()]).catch(() => { setStatus('offline'); feedStatus('Offline, retrying') })
setInterval(() => { if (!document.hidden) tick() }, 4000)
const rules = () => loadRules().catch(() => setTimeout(rules, 15000))
rules()
const tricks = () => loadTricks().catch(() => {})
// the tricks name amounts in the pot's unit, so they wait for the first pot
tick().then(tricks)
setInterval(() => { if (!document.hidden) tricks() }, 30000)
setInterval(() => { for (const t of document.querySelectorAll('time[datetime]')) t.textContent = ago(Date.parse(t.dateTime)) }, 15000)
