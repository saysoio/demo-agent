// Who a sender poses as: a vendor or colleague from the game's directory, matched exactly or by a close imitation
// (a look-alike letter, one or two typos, the name inside a longer one). The page warns that, in real life, sending as
// them takes their stolen account. A plain script so app.js can use it; test/posing.test.ts runs the same file.
const Posing = (() => {
  // letters from other scripts and digits that pass for Latin letters; NFKC has already folded fullwidth forms
  const LOOK = {
    а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ɡ: 'g',
    α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
    0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', $: 's', '|': 'l',
  }
  /** Letters only, look-alikes folded the same way on both sides: "N0rthwlnd-Hosting" and "northwind hosting" agree. */
  function skeleton(s) {
    let t = String(s).normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    t = [...t].map(c => LOOK[c] ?? c).join('')
    return t.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/i/g, 'l').replace(/[^a-z]/g, '')
  }
  function edits(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
    return prev[b.length]
  }
  // a typo or two passes for the real thing, once a name is long enough that it still reads as that name
  const near = (p, k) => p === k || (k.length >= 6 && edits(p, k) <= (k.length >= 12 ? 2 : 1))
  const noTld = d => d.replace(/\.[^.]*$/, '')

  /** The parts of a sender worth comparing: a display name, an email's mailbox and domain (its last label dropped), an @handle. */
  function parts(from) {
    const s = String(from).normalize('NFKC').trim()
    const m = /^(.*?)\s*<([^<>]*)>$/.exec(s)
    const name = m ? m[1] : s, mail = m ? m[2] : s
    const out = []
    const at = mail.indexOf('@')
    if (at > 0) out.push(mail.slice(0, at), noTld(mail.slice(at + 1)))
    else if (at === 0) out.push(mail.slice(1))
    if (m || !s.includes('@')) out.push(name)
    return out.map(skeleton).filter(Boolean)
  }

  /** The directory name a sender poses as, or null. `dir` is what /api/directory sends. */
  function posingAs(from, dir) {
    if (typeof from !== 'string' || !from.trim() || !dir) return null
    const ps = parts(from)
    if (!ps.length) return null
    const people = [
      ...(dir.vendors ?? []).map(v => ({
        name: v.name,
        keys: [v.name, noTld(String(v.website ?? '')), String(v.email ?? '').split('@')[1] ? noTld(String(v.email).split('@')[1]) : '', String(v.x ?? '')],
        // the X handle's first word alone ("northwind") is too common a word to find inside other names
        exact: [String(v.x ?? '').replace(/^@/, '').replace(/_?demo$/i, '')],
      })),
      ...(dir.colleagues ?? []).map(c => ({ name: c.name, keys: [c.name], exact: [...String(c.name).split(/\s+/), String(c.chat ?? '').replace(/^@/, '')] })),
    ]
    for (const p of people) {
      if (typeof p.name !== 'string' || !p.name) continue
      const keys = [...new Set(p.keys.map(skeleton))].filter(k => k.length >= 4)
      const exact = new Set(p.exact.map(skeleton).filter(k => k.length >= 3))
      if (ps.some(x => [...exact].some(k => near(x, k)) || keys.some(k => x.includes(k) || near(x, k)))) return p.name
    }
    return null
  }

  const warning = name => `Posing as ${name}. In real life this needs their stolen account, which attackers usually get by social engineering (phishing, fake login pages).`

  return { posingAs, warning, skeleton }
})()
