/**
 * Client-half tests: the browser bundle contract, both keyed registrations, and
 * the markup each one produces.
 *
 * The bundle is evaluated under a stub `window.__ModuleLoader__` and rendered
 * with a real React DOM server, so these tests fail on a broken registration
 * path, a lost turn data source, or a relaxed sandbox rather than in the
 * browser.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { REACT_ROOTS, loadBundle, makeSandbox, requireFirst } from './helpers.mjs'

const MAX_RENDER_BYTES = 256 * 1024

let sandbox
let bundle
let React
let renderToStaticMarkup
let state

const t = (key) => key

/**
 * One Tool-call entry as the turn data source publishes it: the node's `data`,
 * not the node, with the root Tool block at the top level.
 */
function entry(key, args, settled = false) {
  const head = { name: 'inline_visual', argsRaw: JSON.stringify(args) }
  return {
    root: settled
      ? { kind: 'tool-result', callId: key, call: head, content: [], isError: false }
      : { phase: 'start', callId: key, ...head },
    children: new Map(),
    parents: new Map(),
  }
}

/** One Tool-call entry owned by a different tool. */
function foreignEntry(key) {
  return { root: { phase: 'start', callId: key, name: 'bash', argsRaw: '{}' }, children: new Map(), parents: new Map() }
}

before(async () => {
  sandbox = makeSandbox()
  React = requireFirst(REACT_ROOTS, 'react', 'DSH_REACT_ROOT')
  renderToStaticMarkup = requireFirst(REACT_ROOTS, 'react-dom/server', 'DSH_REACT_ROOT').renderToStaticMarkup

  bundle = await loadBundle(join(sandbox.dir, 'lib', 'client.js'), (spec) => {
    if (spec === 'react') return React
    throw new Error(`unexpected client module request: ${spec}`)
  })

  state = { namespace: null, dictionaries: null, seats: [], registrations: [], snapshot: undefined }
  bundle.exports.apply({
    effect(run) {
      run()
    },
    locale: {
      register(namespace, dictionaries) {
        state.namespace = namespace
        state.dictionaries = dictionaries
      },
    },
    slots: {
      inject(seat, callback) {
        state.seats.push(seat)
        callback()
      },
      register(definition, component) {
        state.registrations.push({ definition, component })
      },
    },
    sessions: {
      binding(sessionId) {
        return { sessionId }
      },
    },
    uiConversation: {
      binding() {
        return {
          target() {
            return {
              getSnapshot() {
                return state.snapshot
              },
            }
          },
        }
      },
    },
  })
})

after(() => {
  sandbox?.cleanup()
})

/**
 * Find one registration by the seat it occupies.
 *
 * @param seat - the slot name.
 * @returns the definition and component.
 */
function registration(seat) {
  const found = state.registrations.find((entry) => entry.definition.name === seat)
  assert.notEqual(found, undefined, `expected a registration in ${seat}`)
  return found
}

/** Render the Turn-tail component with a stubbed keyed hook. */
function renderTail(entries, turn = { turn: 3 }) {
  const { component } = registration('conversation.chat.turnTail')
  return renderToStaticMarkup(React.createElement(component, { turn, useVisuals: () => entries, t }))
}

/** Read the sandbox attribute the markup emitted, if any. */
function sandboxAttribute(markup) {
  const match = /sandbox="([^"]*)"/i.exec(markup)
  return match === null ? null : match[1]
}

/**
 * Read and unescape a frame's `srcdoc` document. Attribute matching is
 * case-insensitive because React's server renderer writes the camelCase
 * property name while the DOM renderer writes the lowercase attribute.
 */
function srcdoc(markup) {
  const match = /srcdoc="([^"]*)"/i.exec(markup)
  assert.notEqual(match, null, 'expected the markup to emit a srcdoc attribute')
  return match[1]
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&')
}

/** Build Tool owner props for the compact row. */
function rowProps(phase, block) {
  return { callId: 'call-1', toolName: 'inline_visual', phase, block, t }
}

test('the bundle registers under the package name', () => {
  assert.equal(bundle.id, 'dsh-inline-visual')
  assert.deepEqual(bundle.exports.inject, ['slots', 'locale', 'sessions', 'uiConversation'])
})

test('claims both Tool row keys and the Turn tail', () => {
  assert.deepEqual(state.seats, ['tool.call.toolview', 'tool.call.toolview', 'conversation.chat.turnTail'])
  const rows = state.registrations.filter((entry) => entry.definition.name === 'tool.call.toolview')
  assert.deepEqual(
    rows.map((entry) => entry.definition.key),
    ['inline_visual', 'html_artifact'],
  )
  assert.equal(rows[0].definition.locale, 'inlineVisual')
  assert.equal(rows[0].component, rows[1].component, 'both wire names share one row component')
  const tail = registration('conversation.chat.turnTail')
  assert.equal(tail.definition.id, 'inline-visual')
  assert.equal(typeof tail.definition.inject, 'function')
})

test('a call recorded under the retired name still renders', () => {
  const args = { html: '<h1>old</h1>', title: 'Legacy' }
  const { component } = registration('tool.call.toolview')
  const markup = renderToStaticMarkup(
    React.createElement(component, {
      callId: 'legacy-1',
      toolName: 'html_artifact',
      phase: 'start',
      block: { phase: 'start', callId: 'legacy-1', name: 'html_artifact', argsRaw: JSON.stringify(args) },
      t,
    }),
  )
  assert.equal(markup.includes('data-tool="html_artifact"'), true)
  assert.equal(markup.includes('Legacy'), true)

  const legacy = {
    root: {
      kind: 'tool-result',
      callId: 'legacy-1',
      call: { name: 'html_artifact', argsRaw: JSON.stringify(args) },
      content: [],
      isError: false,
    },
  }
  assert.equal(renderTail([legacy]).includes('<iframe'), true)
})

test('registers both dictionaries with matching keys', () => {
  assert.equal(state.namespace, 'inlineVisual')
  assert.deepEqual(Object.keys(state.dictionaries.en).sort(), Object.keys(state.dictionaries.zh).sort())
})

test('the compact row names the visual and defers the frame', () => {
  const { component } = registration('tool.call.toolview')
  const markup = renderToStaticMarkup(
    React.createElement(
      component,
      rowProps('start', {
        phase: 'start',
        callId: 'c',
        name: 'inline_visual',
        argsRaw: JSON.stringify({ html: '<h1>hi</h1>', title: 'Demo' }),
      }),
    ),
  )
  assert.equal(markup.includes('data-tool="inline_visual"'), true)
  assert.equal(markup.includes('Demo'), true)
  assert.equal(markup.includes('below'), true)
  assert.equal(markup.includes('11 B'), true)
  assert.equal(markup.includes('<iframe'), false)
})

test('the compact row reports every incomplete or failed state', () => {
  const { component } = registration('tool.call.toolview')
  const draw = (phase, block) => renderToStaticMarkup(React.createElement(component, rowProps(phase, block)))
  assert.equal(draw('preparing', { phase: 'preparing', name: 'inline_visual', argsRaw: '' }).includes('preparing'), true)
  assert.equal(draw('start', { phase: 'start', name: 'inline_visual', argsRaw: '{"html":"<h1>' }).includes('receiving'), true)
  assert.equal(
    draw('result', { kind: 'tool-result', call: { name: 'inline_visual', argsRaw: 'garbage' }, content: [], isError: false }).includes(
      'unavailable',
    ),
    true,
  )
  const failed = draw('result', {
    kind: 'tool-result',
    call: null,
    content: [],
    isError: true,
    error: { message: 'boom' },
  })
  assert.equal(failed.includes('boom'), true)
})

test('the Turn tail renders one sandboxed frame per visual', () => {
  const markup = renderTail([
    entry('a', { html: '<h1>one</h1>' }),
    foreignEntry('b'),
    entry('c', { html: '<p>two</p>', height: 420 }, true),
  ])
  assert.equal(markup.includes('data-inline-visuals="2"'), true)
  assert.equal(markup.split('<iframe').length - 1, 2)
  assert.equal(sandboxAttribute(markup), 'allow-scripts')
  assert.equal(markup.includes('allow-same-origin'), false)
  assert.equal(markup.includes('height:360px'), true)
  assert.equal(markup.includes('height:420px'), true)
})

test('the frame reports its own height instead of offering an expand control', () => {
  const markup = renderTail([entry('a', { html: '<h1>hi</h1>', height: 600 })])
  assert.equal(markup.includes('<button'), false)
  assert.equal(markup.includes('height:600px'), true, 'the requested height is the starting height')
  const document = srcdoc(markup)
  assert.equal(document.split('dsh-inline-visual:height').length - 1, 1)
  assert.equal(document.includes('ResizeObserver'), true)
  assert.equal(document.indexOf('dsh-inline-visual:height') < document.indexOf('<h1>hi</h1>'), true)
})

test('the frame stays out of sight until its height is settled', () => {
  const markup = renderTail([entry('a', { html: '<h1>hi</h1>', height: 600 })])
  assert.equal(markup.includes('visibility:hidden'), true, 'the guess is not painted')
  assert.equal(markup.includes('display:none'), false, 'a frame without layout measures zero')
  assert.equal(markup.includes('height:600px'), true, 'the space is still held while it settles')
})

test('a frame that fits cannot show a scrollbar of its own', () => {
  const { buildDocument } = bundle.exports.__internals
  const document = buildDocument('<h1>hi</h1>')

  assert.equal(document.includes('style.overflowY'), true, 'the reporter decides the overflow')
  assert.equal(document.includes('?"auto":"hidden"'), true, 'a fitting document hides its bar')
  assert.equal(
    document.includes('height>1200?"auto":"hidden"'),
    true,
    'a document above the cap keeps its bar, because the content really does not fit',
  )
})

test('a reported height fits the frame to the content', () => {
  const { frameHeight, reportedHeight } = bundle.exports.__internals

  assert.equal(reportedHeight({ type: 'dsh-inline-visual:height', height: 184 }), 184)
  assert.equal(reportedHeight({ type: 'dsh-inline-visual:height', height: '184' }), 184)
  assert.equal(reportedHeight({ type: 'dsh-inline-visual:height', height: -5 }), null)
  assert.equal(reportedHeight({ type: 'other:height', height: 184 }), null)
  assert.equal(reportedHeight({ type: 'dsh-inline-visual:height' }), null)
  assert.equal(reportedHeight(null), null)

  assert.equal(frameHeight(184, 600), 184, 'a short visual shrinks below its request')
  assert.equal(frameHeight(10, 600), 32, 'a fit never collapses past the floor')
  assert.equal(frameHeight(9000, 600), 1200, 'a fit stops at the maximum')
  assert.equal(frameHeight(null, 600), 600, 'no report means the requested height')
  assert.equal(frameHeight(null, 5000), 1200, 'a request is clamped, never fitted')
  assert.equal(frameHeight(null, 1), 120)
  assert.equal(frameHeight(184.4, 600), 185, 'a fractional fit rounds up, never down')
  assert.equal(frameHeight(32.2, 600), 33, 'the floor is a fit, so it rounds up too')
})

test('the frame edge and the fit never leave a pixel of scrollbar', () => {
  const { buildDocument, css } = bundle.exports.__internals

  const document = buildDocument('<p>x</p>')
  assert.equal(document.includes('Math.ceil'), true, 'the report rounds up')
  assert.equal(document.includes('clientHeight'), true, 'leftover overflow is added to the ask')
  assert.equal(document.includes('Math.round(measure())'), false, 'rounding to nearest can fall short')

  const frame = /\.dshiv_frame\{([^}]*)\}/.exec(css)
  assert.notEqual(frame, null, 'the frame rule is present')
  assert.equal(
    frame[1].includes('border:0'),
    true,
    'a border would come out of the measured height under border-box sizing',
  )
  assert.equal(frame[1].includes('outline:'), true, 'the edge is drawn with an outline instead')
})

test('the Turn tail renders nothing without visuals', () => {
  assert.equal(renderTail([]), '')
  assert.equal(renderTail(undefined), '')
  assert.equal(renderTail([foreignEntry('b')]), '')
  assert.equal(renderTail([entry('a', { html: 42 })]), '')
})

test('the frame document carries the restrictive policy', () => {
  const document = srcdoc(renderTail([entry('a', { html: '<h1>hi</h1>' })]))
  assert.equal(document.startsWith('<!DOCTYPE html>'), true)
  assert.equal(document.includes('<meta http-equiv="Content-Security-Policy"'), true)
  assert.equal(document.includes("default-src 'none'"), true)
  assert.equal(document.includes("connect-src 'none'"), true)
  assert.equal(document.includes('<h1>hi</h1>'), true)
})

test('an authored document keeps its own head and gains the policy', () => {
  const authored = '<!DOCTYPE html><html><head><title>x</title></head><body>y</body></html>'
  const document = srcdoc(renderTail([entry('a', { html: authored })]))
  assert.equal(document.includes('<title>x</title>'), true)
  assert.equal(document.indexOf('<head>') < document.indexOf('Content-Security-Policy'), true)
  assert.equal(document.split('Content-Security-Policy').length - 1, 1)
})

test('an html element without a head still gains one', () => {
  const document = srcdoc(renderTail([entry('a', { html: '<html><body>z</body></html>' })]))
  assert.equal(document.includes('<head><meta charset="utf-8">'), true)
  assert.equal(document.includes('<body>z</body>'), true)
})

test('clamps a requested height to the supported range', () => {
  assert.equal(renderTail([entry('a', { html: 'x', height: 5000 })]).includes('height:1200px'), true)
  assert.equal(renderTail([entry('a', { html: 'x', height: 1 })]).includes('height:120px'), true)
})

test('refuses to render an oversized visual', () => {
  const markup = renderTail([entry('a', { html: 'a'.repeat(MAX_RENDER_BYTES + 1) })])
  assert.equal(markup.includes('tooLarge'), true)
  assert.equal(markup.includes('<iframe'), false)
})

test('the tail hook asks its own Turn for Tool-call nodes', () => {
  const calls = []
  state.snapshot = {
    nodes: {
      turnDataSource(turn, kind) {
        calls.push([turn, kind])
        return 'source'
      },
    },
  }
  const { definition } = registration('conversation.chat.turnTail')
  const face = definition.inject('session-1')
  assert.equal(face.keyedHooks.visuals('7'), 'source')
  assert.deepEqual(calls, [[7, 'tool-call']])
})

test('the tail hook degrades quietly instead of blanking the tail', () => {
  const calls = []
  const { definition } = registration('conversation.chat.turnTail')
  const face = definition.inject('session-1')

  state.snapshot = undefined
  assert.equal(face.keyedHooks.visuals('7'), undefined)

  state.snapshot = { nodes: {} }
  assert.equal(face.keyedHooks.visuals('7'), undefined)

  state.snapshot = {
    nodes: {
      turnDataSource(turn, kind) {
        calls.push([turn, kind])
        return 'source'
      },
    },
  }
  assert.equal(face.keyedHooks.visuals('not-a-turn'), undefined)
  assert.equal(face.keyedHooks.visuals(''), undefined)
  assert.equal(face.keyedHooks.visuals('7'), 'source')
  assert.deepEqual(calls, [[7, 'tool-call']])
})

test('the tail addresses its Turn in either prop shape', () => {
  const keys = []
  const { component } = registration('conversation.chat.turnTail')
  const draw = (turn) =>
    renderToStaticMarkup(
      React.createElement(component, {
        turn,
        useVisuals: (key) => {
          keys.push(key)
          return []
        },
        t,
      }),
    )

  assert.equal(draw({ turn: 9, status: 'closed' }).includes('iframe'), false)
  assert.equal(draw(11).includes('iframe'), false)
  assert.equal(draw({ kind: 'session' }).includes('iframe'), false)
  assert.equal(draw(undefined).includes('iframe'), false)
  assert.deepEqual(keys, ['9', '11', undefined, undefined])
})

test('falls back to English when the locale seat is absent', () => {
  const { component } = registration('tool.call.toolview')
  const markup = renderToStaticMarkup(
    React.createElement(component, {
      callId: 'c',
      toolName: 'inline_visual',
      phase: 'preparing',
      block: { phase: 'preparing', name: 'inline_visual', argsRaw: '' },
    }),
  )
  assert.equal(markup.includes('Inline visual'), true)
})
