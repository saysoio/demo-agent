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

// what the pot holds, in words: Sepolia ETH is test money
const MONEY = { base: 'real money', 'base-sepolia': 'test money' }
// shown to at most this many decimals; the exact amount stays in the title
const SHOWN_DECIMALS = { ETH: 4, USDC: 2 }
function amountText(v, u) {
  const n = Number(v), d = SHOWN_DECIMALS[u] ?? 4
  if (!Number.isFinite(n)) return '…'
  if (n > 0 && n < 10 ** -d) return `<${(10 ** -d).toFixed(d)}`
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: d }).format(n)
}
const short = a => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '')
const ago = t => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago` }
const get = path => fetch(path, { headers: { accept: 'application/json' } }).then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches
// The dot field behind the hero, after the site's (apps/site/dots.js): dots on one square grid, thinned by an ordered
// dither, cleared under the text. Drawn once per layout; alive only while on screen and motion is allowed: a few dots
// brighten now and then, and a verdict that lands while the page is open sends a ring of its colour through the grid.
const field = (() => {
  const cv = $('field'), g = cv.getContext?.('2d')
  if (!g) return { ring() {} }
  const hero = cv.parentElement
  const TONE = ['#262F37', '#36424D', '#4F5B67'], UP = ['#4F5B67', '#6E7883', '#9AA2AC']
  const SHADES = { block: ['#CE585B', '#B95159', '#A74954', '#C9504E'], allow: ['#5AA66C', '#509566', '#528658', '#57A05B'] }
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
  const hash = (x, y) => { let h = Math.imul(x * 374761393 + y * 668265263, 1274126177); h ^= h >>> 13; return ((Math.imul(h, 1103515245) >>> 0) % 10007) / 10007 }
  let cell = 14, ds = 5, dpr = 1, dots = [], lit = new Map(), visible = false, ringAt = null
  const motion = () => !still() && visible && !document.hidden

  function build() {
    const w = hero.clientWidth, h = hero.clientHeight
    if (!w || !h) return
    dpr = Math.min(2, devicePixelRatio || 1); cell = w < 600 ? 12 : 14; ds = Math.max(2, Math.round(cell * 0.36))
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr)
    const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell), box = hero.getBoundingClientRect()
    // under the text: whole cells cleared, plus a cell of margin
    const zones = [...hero.querySelectorAll('[data-clear]')].map(e => {
      const r = e.getBoundingClientRect()
      return [Math.floor((r.left - box.left) / cell) - 1, Math.ceil((r.right - box.left) / cell) + 1, Math.floor((r.top - box.top) / cell) - 1, Math.ceil((r.bottom - box.top) / cell) + 1]
    })
    const blobs = Array.from({ length: Math.max(5, Math.round(cols * rows / 420)) }, (_, i) => ({
      x: hash(i, 1) * cols, y: hash(i, 2) * rows, sx: 3 + hash(i, 3) * 12, sy: 2.5 + hash(i, 4) * 7, a: 0.45 + hash(i, 5) * 0.7, sq: hash(i, 6) < 0.55,
    }))
    dots = []
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (zones.some(z => x >= z[0] && x < z[1] && y >= z[2] && y < z[3])) continue
      let v = (hash(x, y) - 0.5) * 0.4
      for (const b of blobs) {
        const dx = Math.abs(x - b.x) / b.sx, dy = Math.abs(y - b.y) / b.sy, d = b.sq ? dx ** 4 + dy ** 4 : dx * dx + dy * dy
        if (d < 9) v += b.a * Math.exp(-d)
      }
      if (v > (BAYER[((y & 3) << 2) + (x & 3)] + 0.5) / 16) dots.push({ x, y, t: v > 1.1 ? 2 : v > 0.42 ? 1 : 0 })
    }
    lit.clear(); draw()
  }
  const px = c => Math.round((c * cell + (cell - ds) / 2) * dpr)
  function dot(d, color) { g.fillStyle = color; g.fillRect(px(d.x), px(d.y), Math.round(ds * dpr), Math.round(ds * dpr)) }
  function draw(now = 0) {
    g.clearRect(0, 0, cv.width, cv.height)
    let ox = 0, oy = 0, r = -1, kind = null
    if (ringAt) {
      const k = (now - ringAt.t) / 1600
      if (k >= 1) ringAt = null
      else { ({ x: ox, y: oy, kind } = ringAt); r = k * ringAt.max }
    }
    for (const d of dots) {
      if (r >= 0) {
        const off = Math.abs(Math.hypot(d.x - ox, d.y - oy) - r)
        if (off < 2.2) { const s = SHADES[kind]; dot(d, s[(d.x * 3 + d.y * 5) % 4]); continue }
      }
      dot(d, lit.has(d) ? UP[d.t] : TONE[d.t])
    }
  }
  function ringFrame(t) { draw(t); if (ringAt) requestAnimationFrame(ringFrame) }

  // twinkle: a handful of dots one tone brighter, each for under a second
  let twinkle = 0
  const twinkleTimer = () => {
    if (motion() && !twinkle) twinkle = setInterval(sparkle, 180)
    else if (!motion() && twinkle) { clearInterval(twinkle); twinkle = 0 }
  }
  function sparkle() {
    if (ringAt || !dots.length) return
    const now = performance.now()
    for (const [d, until] of lit) if (until < now) { lit.delete(d); g.clearRect(px(d.x) - 1, px(d.y) - 1, Math.round(ds * dpr) + 2, Math.round(ds * dpr) + 2); dot(d, TONE[d.t]) }
    for (let i = 0; i < 2; i++) { const d = dots[Math.floor(Math.random() * dots.length)]; lit.set(d, now + 500 + Math.random() * 700); dot(d, UP[d.t]) }
  }

  let queued = false
  const rebuild = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; build() }) } }
  new ResizeObserver(rebuild).observe(hero)
  for (const e of hero.querySelectorAll('[data-clear]')) new ResizeObserver(rebuild).observe(e)
  document.fonts?.ready.then(rebuild)
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; twinkleTimer() }).observe(hero)
  document.addEventListener('visibilitychange', twinkleTimer)
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', twinkleTimer)

  return {
    ring(kind) {
      if (!kind || !SHADES[kind] || !motion() || !dots.length) return
      const pot = document.querySelector('.pot').getBoundingClientRect(), box = hero.getBoundingClientRect()
      const x = (pot.left + pot.width / 2 - box.left) / cell, y = (pot.top + pot.height / 2 - box.top) / cell
      const max = Math.hypot(Math.max(x, hero.clientWidth / cell - x), Math.max(y, hero.clientHeight / cell - y))
      const start = !ringAt
      ringAt = { x, y, kind, max, t: performance.now() }
      if (start) requestAnimationFrame(ringFrame)
    },
  }
})()

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
  li.querySelector('.who').textContent = a.source === 'vendor' ? `${a.handle}, our vendor` : `@${a.handle}`
  li.querySelector('.chan').textContent = CHANNEL[a.channel] ?? a.channel
  const time = li.querySelector('time'); time.dateTime = new Date(a.createdAt).toISOString(); time.textContent = ago(a.createdAt)
  labelled(li.querySelector('.from'), 'From', a.from ?? '')
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
  const bal = $('balance')
  bal.textContent = p.balance == null ? '…' : amountText(p.balance, p.unit); bal.title = p.balance == null ? '' : `${p.balance} ${p.unit}`
  $('unit').textContent = p.unit
  for (const m of document.querySelectorAll('.money')) m.textContent = MONEY[p.network] ?? 'funds'
  $('address').textContent = short(p.address); $('explorer').href = `${explorerBase}/address/${p.address}`
  $('network').textContent = p.network === 'base' ? `Real ${p.unit} on Base` : `Test ${p.unit} on Base Sepolia, for now`
  setStatus(p.paused ? 'paused' : 'live')
  const note = $('pause-note')
  note.hidden = !p.paused
  note.textContent = p.budgetPaused ? 'Paused for budget: the agent has used its model budget for today. It is back after midnight UTC.' : p.paused ? 'The game is paused for now.' : ''
  showSource(p.source)
  ledger(p.stats)
  $('s-queued').textContent = p.queued
  $('send').disabled = !!p.paused
  const v = $('vendors')
  if (!v.childElementCount) for (const x of p.vendors) {
    const li = document.createElement('li'), n = document.createElement('span'), ad = document.createElement('code')
    n.className = 'v-name'; n.textContent = x.name; ad.className = 'v-addr'; ad.textContent = x.address
    li.append(n, ad); v.append(li)
  }
}

// every player's try as one cell, grouped by what happened; past CELLS_MAX tries a cell stands for several
const CELLS_MAX = 160
let ledgerKey = ''
function ledger(s) {
  // pending tries (in line or being thought about) have no outcome yet; the rest made no payment at all (ignored,
  // nothing to pay, no answer, not sent or paused)
  const pending = s.pending ?? 0, vendorPaid = Math.max(0, s.paid - s.wins), other = Math.max(0, s.attempts - s.blocked - s.paid - pending)
  $('s-attempts').textContent = s.attempts; $('s-blocked').textContent = s.blocked; $('s-paid').textContent = vendorPaid
  $('s-other').textContent = other; $('s-wins').textContent = s.wins
  const key = [s.attempts, s.blocked, s.paid, s.wins, pending].join()
  if (key === ledgerKey) return
  ledgerKey = key
  const per = Math.max(1, Math.ceil(s.attempts / CELLS_MAX)), n = x => (x > 0 ? Math.max(1, Math.round(x / per)) : 0)
  const cells = []
  for (const [count, cls] of [[s.wins, 'win'], [s.blocked, 'block'], [vendorPaid, 'allow'], [other, 'quiet'], [pending, 'wait']]) {
    for (let i = n(count); i > 0; i--) { const c = document.createElement('i'); c.className = cls; cells.push(c) }
  }
  const box = $('cells')
  box.className = `cells${cells.length > 60 ? ' many' : cells.length > 24 ? ' mid' : ''}`
  box.replaceChildren(...cells)
  box.setAttribute('aria-label', s.attempts
    ? `${s.attempts} tries: ${s.blocked} stopped by Sayso, ${vendorPaid} paid a real vendor, ${other} with no payment, ${s.wins} broke the guard${pending ? `, ${pending} waiting` : ''}${per > 1 ? `. Each square is about ${per} tries` : ''}`
    : 'No tries yet')
}

// the link appears only for an https URL the server sends
function showSource(url) {
  const ok = typeof url === 'string' && url.startsWith('https://')
  for (const a of [$('code-link'), $('foot-link')]) if (ok) a.href = url
  $('code-link').hidden = !ok; $('foot-code').hidden = !ok
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }

async function loadRules() {
  const r = await get('/api/rules')
  const amt = x => `${x} ${r.unit}`
  const v = $('g-vendors'); v.replaceChildren()
  for (const x of r.vendors) {
    const li = el('li'), ad = el('code', '', short(x.address)); ad.title = x.address
    li.append(el('i', 'mk allow'), el('span', 'p-name', x.name), ad); v.append(li)
  }
  const rest = el('li', 'else'); rest.append(el('i', 'mk block'), el('span', 'p-name', 'Anyone else'), el('b', '', 'Blocked')); v.append(rest)
  $('g-per').textContent = amt(r.perPayment); $('g-day').textContent = amt(r.daily); $('g-week').textContent = amt(r.weekly)
  // each cap drawn as payments at the per-payment cap: one square each
  const per = Number(r.perPayment)
  for (const [id, x] of [['g-per-bar', r.perPayment], ['g-day-bar', r.daily], ['g-week-bar', r.weekly]]) {
    const n = per > 0 ? Math.min(60, Math.round(Number(x) / per)) : 0
    $(id).replaceChildren(...Array.from({ length: Number.isFinite(n) ? n : 0 }, () => el('i')))
  }
  const acts = $('g-actions'); acts.replaceChildren()
  if (r.actions.length === 1 && r.actions[0] === 'transfer') {
    const yes = el('li', 'yes'); yes.append(el('i', 'mk allow'), el('span', '', `Plain ${r.unit} transfers to these payees`)); acts.append(yes)
    for (const t of ['Token trades', 'Contract calls', 'Spending approvals', 'Signed messages']) {
      const li = el('li', 'no'); li.append(el('i', 'mk block'), el('span', '', t)); acts.append(li)
    }
  } else for (const a of r.actions) acts.append(el('li', 'yes', a))
  const st = $('g-strict')
  for (const s of st.children) s.classList.toggle('on', s.dataset.v === r.strictness)
  st.setAttribute('role', 'img'); st.setAttribute('aria-label', `Strictness: ${r.strictness}`)
  // the enforce claims follow what the rules say; any other mode shows as neutral
  const enforce = r.sdk.mode === 'enforce'
  $('g-mode').textContent = enforce ? 'Enforce mode on' : `${r.sdk.mode} mode`
  $('g-sdk').textContent = `${r.sdk.name} ${r.sdk.version}${enforce ? ": nothing is signed without Sayso's allow" : ": Sayso's verdicts are not enforced"}`
  $('g-mode-mk').className = `mk${enforce ? ' allow' : ''}`
  const en = $('g-enforce'); en.className = `status${enforce ? ' live' : ''}`; en.querySelector('.status-t').textContent = enforce ? 'Enforcing' : 'Not enforcing'
  const w = $('fl-wallet'); w.textContent = enforce ? 'signs only if Sayso says allow' : "signs without waiting for Sayso's allow"; w.hidden = false
  $('g-server-row').hidden = !r.checkServer
  if (r.checkServer) $('g-server').textContent = r.checkServer.replace(/^https:\/\//, '')
  $('g-signed').textContent = r.signedVerdicts ? 'Every one signed by Sayso. The wallet checks the signature.' : 'Unsigned'
  $('g-source').textContent = r.source === 'signed rules'
    ? `The signed rules, word for word${r.signedAt ? ` (signed ${r.signedAt.slice(0, 10)})` : ''}`
    : 'The published rules, word for word'
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
  labelled(li.querySelector('.from'), 'From', a.from ?? '')
  li.querySelector('.t-body').textContent = a.excerpt
  li.querySelector('.what').textContent = a.toAddr ? `${a.amount} ${unit} to ${short(a.toAddr)}` : ''
  li.querySelector('.rule').textContent = Object.hasOwn(RULE, a.rule) ? RULE[a.rule] : ''
  li.querySelector('.reason').textContent = a.reason ?? ''
  return li
}

function carButtons() {
  const l = $('t-list'), end = l.scrollWidth - l.clientWidth - 2
  // aria-disabled, not disabled, so a button at the end keeps keyboard focus
  $('t-prev').setAttribute('aria-disabled', String(l.scrollLeft <= 2)); $('t-next').setAttribute('aria-disabled', String(l.scrollLeft >= end))
}
function carStep(dir) {
  if ($(dir < 0 ? 't-prev' : 't-next').getAttribute('aria-disabled') === 'true') return
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
    const fresh = !shown.has(a.id), was = waiting.has(a.id)
    const li = render(a)
    // a verdict that lands while the page is open sends a ring through the dot field
    if (a.status === 'done' && (was || (fresh && !first))) field.ring(a.win || a.outcome === 'blocked' ? 'block' : a.outcome === 'paid' ? 'allow' : null)
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
  const handle = $('handle').value.trim(), text = $('text').value, from = $('from').value.trim()
  const channel = new FormData($('form')).get('channel')
  btn.disabled = true; msg.textContent = 'Sending…'; msg.className = 'msg'
  try {
    const r = await fetch('/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, channel, from, text }) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error ?? `error ${r.status}`)
    try { localStorage.setItem('handle', handle) } catch { /* storage blocked */ }
    $('text').value = ''; $('count').textContent = '0'; $('count-wrap').className = 'count'
    msg.textContent = `In the inbox (#${j.id}). Watch the feed.`
    loadFeed().catch(() => {})
  } catch (err) { msg.textContent = err.message; msg.className = 'msg bad' } finally { btn.disabled = false }
})

// The directory: who the player can pose as. A name, address or handle fills From (switching to a channel it fits);
// every detail has its own copy button. All of it is set as text.
let people = { vendors: [], colleagues: [] }
// what a directory pick put in From, so a channel change can swap it for the same sender's identity on the new channel
let picked = null
const SENDER = {
  email: { hint: '(email address)', ph: d => d.vendors[0]?.email ?? 'billing@northwind-hosting.example' },
  invoice: { hint: '(name and email)', ph: d => (d.vendors[0] ? `${d.vendors[0].name} <${d.vendors[0].email}>` : 'Northwind Hosting <billing@northwind-hosting.example>') },
  post: { hint: '(X handle)', ph: d => d.vendors[0]?.x ?? '@northwind_demo' },
  chat: { hint: '(name in the team chat)', ph: d => d.colleagues[0]?.name ?? 'Dana Okafor' },
}
const channelNow = () => new FormData($('form')).get('channel')
// the sender a vendor or colleague would be on a channel, or null when they are not on it
function identity(who, ch) {
  if (who.kind === 'colleague') return ch === 'chat' ? who.p.name : null
  if (ch === 'email') return who.p.email
  if (ch === 'invoice') return `${who.p.name} <${who.p.email}>`
  if (ch === 'post') return who.p.x
  return null
}
function senderField() {
  const ch = channelNow(), s = SENDER[ch] ?? SENDER.email
  $('from-label').querySelector('.lab-hint').textContent = s.hint
  $('from').placeholder = s.ph(people)
}
function say(text) { const l = $('dir-live'); l.textContent = ''; setTimeout(() => { l.textContent = text }, 30) }

function useSender(who, ch) {
  const r = $('form').querySelector(`input[name="channel"][value="${ch}"]`)
  if (r && !r.checked) r.checked = true
  const v = identity(who, ch)
  $('from').value = v; picked = { who, value: v }
  senderField()
  say(`Sending as ${v}`)
}

// copy, with a fallback that selects the text so the player can copy it by hand
async function copy(btn, text, valueEl) {
  try {
    await navigator.clipboard.writeText(text)
    btn.classList.add('done'); btn.querySelector('.cp-t').textContent = 'Copied'
    say(`Copied ${text}`)
    clearTimeout(btn.t); btn.t = setTimeout(() => { btn.classList.remove('done'); btn.querySelector('.cp-t').textContent = '' }, 1600)
  } catch {
    const sel = getSelection(), range = document.createRange()
    range.selectNodeContents(valueEl); sel.removeAllRanges(); sel.addRange(range)
    say('Copy is blocked here. The text is selected: copy it with your keyboard.')
  }
}

// one detail: its value (a button when it can be a sender) and a copy button
function chip(o) {
  const c = el('span', `chip${o.kind ? ` chip-${o.kind}` : ''}`)
  let v
  if (o.use) {
    v = el('button', 'chip-v', o.shown ?? o.value); v.type = 'button'
    v.setAttribute('aria-label', `Send as ${o.value}`)
    v.addEventListener('click', o.use)
  } else v = el('span', 'chip-v', o.shown ?? o.value)
  if (o.shown) v.title = o.value
  const b = el('button', 'chip-cp'); b.type = 'button'
  b.setAttribute('aria-label', `Copy ${o.label}`)
  b.append(el('i', 'cp-i'), el('span', 'cp-t'))
  b.addEventListener('click', () => copy(b, o.value, v))
  c.append(v, b)
  return c
}

async function loadDirectory() {
  people = await get('/api/directory')
  const list = $('dir-vendors'); list.replaceChildren()
  for (const p of people.vendors) {
    const who = { kind: 'vendor', p }
    const li = el('li', 'dir-v'), top = el('div', 'dir-top')
    top.append(el('span', 'dir-name', p.name), el('span', 'dir-usual', `usually ${p.usual} ${unit}`.trim()))
    const chips = el('div', 'chips')
    chips.append(
      chip({ value: p.email, label: `${p.name}'s billing email`, kind: 'mail', use: () => useSender(who, channelNow() === 'invoice' ? 'invoice' : 'email') }),
      chip({ value: p.x, label: `${p.name}'s X handle`, kind: 'x', use: () => useSender(who, 'post') }),
      chip({ value: p.wallet, shown: short(p.wallet), label: `${p.name}'s wallet address`, kind: 'wallet' }),
      chip({ value: p.website, label: `${p.name}'s website`, kind: 'web' }),
    )
    li.append(top, chips); list.append(li)
  }
  const team = $('dir-team'); team.replaceChildren()
  for (const p of people.colleagues) {
    const li = el('li')
    li.append(chip({ value: p.name, label: `${p.name}'s name`, use: () => useSender({ kind: 'colleague', p }, 'chat') }), el('span', 'dir-role', p.role))
    team.append(li)
  }
  senderField()
}

for (const r of document.querySelectorAll('input[name="channel"]')) r.addEventListener('change', () => {
  // a sender picked from the directory follows the channel: the same vendor's handle on a post, and so on
  if (picked && $('from').value === picked.value) {
    const v = identity(picked.who, channelNow())
    $('from').value = v ?? ''; picked = v ? { who: picked.who, value: v } : null
  }
  senderField()
})

const tick = () => Promise.all([loadPot(), loadFeed()]).catch(() => { setStatus('offline'); feedStatus('Offline, retrying') })
setInterval(() => { if (!document.hidden) tick() }, 4000)
const rules = () => loadRules().catch(() => setTimeout(rules, 15000))
rules()
const tricks = () => loadTricks().catch(() => {})
const dir = () => loadDirectory().catch(() => setTimeout(dir, 15000))
senderField()
// the tricks and the directory name amounts in the pot's unit, so they wait for the first pot
tick().then(() => { tricks(); dir() })
setInterval(() => { if (!document.hidden) tricks() }, 30000)
setInterval(() => { for (const t of document.querySelectorAll('time[datetime]')) t.textContent = ago(Date.parse(t.dateTime)) }, 15000)
