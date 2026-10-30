import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { loadConfig } from '../src/config.ts'
import { directory } from '../src/directory.ts'

// the page's own file, run as the browser runs it: a plain script that leaves `Posing` behind
const src = readFileSync(new URL('../public/game/posing.js', import.meta.url), 'utf8')
const Posing = runInNewContext(`${src}\n;Posing`) as { posingAs(from: unknown, dir: unknown): string | null; warning(name: string): string }
const dir = directory(loadConfig({ DEMO_FAKE: '1', DEMO_DEV: '1' }).vendors)
const as = (from: unknown) => Posing.posingAs(from, dir)

test('a sender from the directory, as given, is posing as that vendor or colleague', () => {
  for (const v of dir.vendors) {
    assert.equal(as(v.email), v.name, v.email)
    assert.equal(as(`${v.name} <${v.email}>`), v.name)
    assert.equal(as(v.x), v.name, v.x)
  }
  for (const c of dir.colleagues) assert.equal(as(c.name), c.name)
})

test('a close imitation counts: look-alike letters, a typo, another mailbox or a longer name', () => {
  const nw = 'Northwind Hosting'
  for (const from of ['ceo@northwind-hosting.example', 'billing@northwlnd-hosting.example', 'billing@n0rthwind-hosting.example',
    'billing@northwind-hosting-payments.example', 'billing@northwindhosting.example', 'Northwind Hosting <pay@mail.example>',
    'Northwlnd Hostinq <billing@x.example>', '@northwind', '@n0rthwind_demo', 'billing@northwind.example', 'billing@nοrthwind-hosting.example'])
    assert.equal(as(from), nw, from)
  assert.equal(as('@lantern_demo'), 'Lantern Design')
  for (const from of ['Dana Okafor, CFO', 'dana okafor', 'Dana 0kafor', 'Dana Okafr', 'Dаna Okafor', 'Dana', 'dana.okafor@mail.example', '@dana', 'Okafor'])
    assert.equal(as(from), 'Dana Okafor', from)
  assert.equal(as('Marcus Lindqvist (Ops)'), 'Marcus Lindqvist')
  assert.equal(as('Lindqvist'), 'Marcus Lindqvist')
})

test('a sender of the player\'s own invention is not posing as anyone', () => {
  for (const from of ['mallory@evil.example', '@random_guy', 'Bob Smith', 'Priyanka Shah', 'Danielle', 'Hosting Support', 'billing@hosting.example',
    'Design Team', 'Lantern Festival', 'Northwind Traders', '@northwind_fan', 'Dana White', 'Marcus Aurelius', '', '   ', null, undefined, 5, '@'])
    assert.equal(as(from), null, String(from))
  assert.equal(Posing.posingAs('Dana Okafor', null), null)
  assert.equal(Posing.posingAs('Dana Okafor', { vendors: [], colleagues: [] }), null)
})

test('the warning is one short line naming who and how attackers get an account', () => {
  const w = Posing.warning('Dana Okafor')
  assert.equal(w, 'Posing as Dana Okafor. In real life this needs their stolen account, which attackers usually get by social engineering (phishing, fake login pages).')
  assert.doesNotMatch(w, /\n/)
})
