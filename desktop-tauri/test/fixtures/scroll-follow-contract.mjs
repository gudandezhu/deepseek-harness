import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(process.argv[2], 'utf8')
const metrics = { top: 0, floor: 400, height: 200 }

function world({ system = false, api = 'function', dom = true } = {}) {
  const root = new Map()
  const body = new Map()
  const preference = { matches: system }
  const queries = []
  const calls = []
  const element = {
    scrollTop: 0,
    scrollTo(options) {
      calls.push({ ...options })
      if (options.behavior === 'instant')
        this.scrollTop = options.top
    },
  }
  const context = {}
  if (dom) {
    context.document = {
      documentElement: {
        hasAttribute: name => root.has(name),
        getAttribute: name => root.get(name) ?? null,
      },
      body: { hasAttribute: name => body.has(name) },
    }
  }
  if (api === 'function') {
    context.matchMedia = (query) => {
      assert.equal(query, '(prefers-reduced-motion: reduce)')
      queries.push(query)
      return preference
    }
  }
  else if (api === 'nonfunction') {
    context.matchMedia = false
  }
  const follow = runInNewContext(`${source}\nnew ScrollFollow(false, 1)`, context, { timeout: 1000 })
  return { follow, element, calls, root, body, preference, queries }
}

function landed(state, input) {
  assert.equal(state.element.scrollTop, input.floor)
  assert.equal(state.follow.animating, false)
  assert.equal(state.follow.active, true)
  assert.equal(state.follow.sample({ ...input, top: input.floor, floor: input.floor + 100 }), true)
  assert.equal(state.follow.settle({ ...input, top: input.floor, floor: input.floor + 100 }), true)
  assert.equal(state.follow.sample({ ...input, top: input.floor - 50, floor: input.floor + 100 }), false)
}

for (const api of ['function', 'missing', 'nonfunction']) {
  for (const value of ['', 'true', '0', 'false']) {
    test(`root attribute presence (${JSON.stringify(value)}, ${api}) jumps without motion`, () => {
      const state = world({ api })
      state.root.set('data-reduce-motion', value)
      const result = state.follow.toBottom(state.element, metrics, 'smooth')
      assert.deepEqual({ ...result }, { ...metrics, top: metrics.floor })
      assert.deepEqual(state.calls, [])
      landed(state, metrics)
    })
  }
  test(`no preference preserves smooth following (${api})`, () => {
    const state = world({ api })
    assert.deepEqual({ ...state.follow.toBottom(state.element, metrics, 'smooth') }, metrics)
    assert.deepEqual(state.calls, [{ top: 400, behavior: 'smooth' }])
    assert.equal(state.element.scrollTop, 0)
    assert.equal(state.follow.animating, true)
    assert.equal(state.follow.active, true)
    assert.equal(state.queries.length, api === 'function' ? 1 : 0)
  })
}

for (const behavior of ['instant', 'smooth']) {
  for (const floor of [400, 600]) {
    for (const policy of ['none', 'root', 'system']) {
      test(`active ${behavior}, floor ${floor}, policy ${policy}`, () => {
        const state = world()
        state.follow.toBottom(state.element, metrics, 'smooth')
        state.calls.length = 0
        state.element.scrollTop = 100
        if (policy === 'root')
          state.root.set('data-reduce-motion', '')
        if (policy === 'system')
          state.preference.matches = true
        const grown = { ...metrics, top: 100, floor }
        const result = state.follow.toBottom(state.element, grown, behavior)
        if (policy !== 'none') {
          assert.deepEqual({ ...result }, { ...grown, top: floor })
          assert.deepEqual(state.calls, [{ top: floor, behavior: 'instant' }])
          landed(state, grown)
        }
        else {
          assert.deepEqual({ ...result }, grown)
          assert.deepEqual(state.calls, behavior === 'instant' && floor !== 400 ? [{ top: floor, behavior: 'smooth' }] : [])
          assert.equal(state.element.scrollTop, 100)
          assert.equal(state.follow.animating, true)
        }
      })
    }
  }
}

for (const system of [false, true]) {
  test(`system preference ${system} respects root absence`, () => {
    const state = world({ system })
    const result = state.follow.toBottom(state.element, metrics, 'smooth')
    assert.equal(result.top, system ? 400 : 0)
    assert.equal(state.follow.animating, !system)
    assert.deepEqual(state.calls, system ? [] : [{ top: 400, behavior: 'smooth' }])
    assert.equal(state.queries.length, 1)
  })
}

test('root and system preferences can be toggled on the same instance', () => {
  const state = world()
  state.follow.toBottom(state.element, metrics, 'smooth')
  state.calls.length = 0
  state.root.set('data-reduce-motion', '')
  state.preference.matches = true
  state.follow.toBottom(state.element, { ...metrics, floor: 600 }, 'instant')
  assert.deepEqual(state.calls, [{ top: 600, behavior: 'instant' }])
  state.calls.length = 0
  state.root.delete('data-reduce-motion')
  assert.equal(state.follow.toBottom(state.element, { ...metrics, top: 600, floor: 800 }, 'smooth').top, 800)
  assert.deepEqual(state.calls, [])
  state.preference.matches = false
  state.follow.toBottom(state.element, { ...metrics, top: 800, floor: 1000 }, 'smooth')
  assert.deepEqual(state.calls, [{ top: 1000, behavior: 'smooth' }])
  assert.equal(state.follow.animating, true)
  state.preference.matches = true
  state.calls.length = 0
  assert.equal(state.follow.toBottom(state.element, { ...metrics, top: 800, floor: 1200 }, 'instant').top, 1200)
  assert.deepEqual(state.calls, [{ top: 1200, behavior: 'instant' }])
  assert.equal(state.follow.animating, false)
})

test('removing the root attribute restores motion without matchMedia', () => {
  const state = world({ api: 'missing' })
  state.root.set('data-reduce-motion', '0')
  assert.equal(state.follow.toBottom(state.element, metrics, 'smooth').top, 400)
  state.root.delete('data-reduce-motion')
  state.follow.toBottom(state.element, { ...metrics, top: 400, floor: 800 }, 'smooth')
  assert.deepEqual(state.calls, [{ top: 800, behavior: 'smooth' }])
})

test('a body-only attribute does not opt out of motion', () => {
  const state = world()
  state.body.set('data-reduce-motion', '')
  state.follow.toBottom(state.element, metrics, 'smooth')
  assert.deepEqual(state.calls, [{ top: 400, behavior: 'smooth' }])
  assert.equal(state.root.has('data-reduce-motion'), false)
})

test('the class remains usable without a document', () => {
  const state = world({ dom: false })
  state.follow.toBottom(state.element, metrics, 'smooth')
  assert.deepEqual(state.calls, [{ top: 400, behavior: 'smooth' }])
})

for (const input of [{ ...metrics, top: 399.5 }, { ...metrics, top: 400.5 }]) {
  test(`no preference preserves the near-bottom jump at ${input.top}`, () => {
    const state = world()
    state.element.scrollTop = input.top
    assert.equal(state.follow.toBottom(state.element, input, 'smooth').top, 400)
    assert.deepEqual(state.calls, [])
    assert.equal(state.follow.animating, false)
  })
}

test('idle instant requests still jump without a preference', () => {
  const state = world()
  assert.equal(state.follow.toBottom(state.element, metrics, 'instant').top, 400)
  assert.deepEqual(state.calls, [])
  assert.equal(state.follow.animating, false)
})

test('an active animation already at the floor is cancelled without a preference', () => {
  const state = world()
  state.follow.toBottom(state.element, metrics, 'smooth')
  state.calls.length = 0
  state.element.scrollTop = 400
  assert.equal(state.follow.toBottom(state.element, { ...metrics, top: 400 }, 'instant').top, 400)
  assert.deepEqual(state.calls, [{ top: 400, behavior: 'instant' }])
  assert.equal(state.follow.animating, false)
})

test('independent containers keep reader, jump and paging state isolated', () => {
  const outer = world()
  const inner = world()
  for (const state of [outer, inner]) {
    state.root.set('data-reduce-motion', '')
    state.follow.bind(state.element)
    state.follow.toBottom(state.element, metrics, 'smooth')
  }
  outer.element.scrollTop = 100
  assert.equal(outer.follow.sample({ ...metrics, top: 100 }), false)
  assert.equal(inner.follow.active, true)
  inner.follow.toBottom(inner.element, { ...metrics, top: 400, floor: 600 }, 'smooth')
  assert.equal(inner.element.scrollTop, 600)
  assert.equal(outer.element.scrollTop, 100)
  const page = outer.follow.jump(outer.element, { ...metrics, top: 100, floor: 900 }, 300)
  assert.equal(page.top, 300)
  assert.equal(outer.follow.active, false)
  assert.equal(inner.follow.active, true)
  assert.equal(outer.follow.toBottom(outer.element, page, 'instant').top, 900)
  assert.equal(outer.follow.active, true)
  assert.equal(inner.element.scrollTop, 600)
})
