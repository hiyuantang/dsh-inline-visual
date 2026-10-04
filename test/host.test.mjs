/**
 * Host-half tests: the registered tool definition, its argument validation, its
 * size and height limits, and the receipt it returns to the model.
 *
 * The plugin imports nothing, so the definition is written by hand. One test
 * proves that hand-written schema is exactly what the official `defineTool`
 * helper would have compiled from the equivalent author spec, so dropping the
 * import costs no schema fidelity.
 *
 * That check is the only reason these tests need the DSH installation, which is
 * also why `DSH_MODULES_ROOT` must point at an extracted copy: Node cannot read
 * the packaged `app.asar`.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { DSH_MODULE_ROOTS, importFile, makeSandbox, requireFirst } from './helpers.mjs'

const MAX_HTML_BYTES = 256 * 1024

const DESCRIPTION = [
  'Render an inline interactive visual in the conversation.',
  'Use it when a small interactive visualization, diagram, or chart explains something better than prose.',
  'Pass one complete HTML document in `html`. Inline CSS and inline JavaScript both run; the frame is sandboxed with scripts only, so it cannot reach the app, the network, or local storage.',
  'Do not reference external files, fonts, images, or URLs: they are blocked. Keep the markup under 256 KiB.',
  'For a large or reusable visual, write an .html file and deliver it with present instead.',
].join(' ')

/** The author-DSL form of the same tool, used only to compare compiled schemas. */
const AUTHOR_SPEC = {
  html: {
    type: 'string',
    required: true,
    description:
      'The complete HTML document to render. Include a doctype or a full <html> element. Inline styles and scripts only; no external resources.',
  },
  title: {
    type: 'string',
    description: 'Short label shown above the visual. Omit when the visual has no useful title.',
  },
  height: {
    type: 'number',
    description: 'Initial frame height in CSS pixels, 120 to 1200. Defaults to 360. The frame then fits the visual content.',
  },
}

const AUTHOR_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bytes: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    title: { type: 'string' },
  },
}

let sandbox
let plugin

before(async () => {
  sandbox = makeSandbox()
  plugin = await importFile(join(sandbox.dir, 'lib', 'index.js'))
})

after(() => {
  sandbox?.cleanup()
})

/**
 * Apply the plugin to a stub context that captures the registered definition.
 *
 * @returns the captured definition.
 */
function register() {
  const captured = { definition: null }
  plugin.apply({
    tools: {
      register(definition) {
        captured.definition = definition
      },
    },
  })
  return captured.definition
}

test('the host half imports nothing, so a row can load it from any path', async () => {
  const source = await readFile(join(sandbox.dir, 'lib', 'index.js'), 'utf8')
  const specifiers = [...source.matchAll(/^\s*(?:import|export)[^'"\n]*from\s+['"]([^'"]+)['"]/gmu)].map(
    (match) => match[1],
  )
  assert.deepEqual(specifiers, [])
})

test('exports the Loader identity and service injection', () => {
  assert.equal(plugin.name, 'inline-visual')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
})

test('registers the inline_visual tool', () => {
  const definition = register()
  assert.equal(definition.name, 'inline_visual')
  assert.equal(definition.description, DESCRIPTION)
  assert.deepEqual(definition.parameters.required, ['html'])
  assert.equal(typeof definition.output.render, 'function')
})

test('the hand-written schemas equal what defineTool compiles', () => {
  const { defineTool } = requireFirst(DSH_MODULE_ROOTS, '@deepseek-ai/dsh-tools', 'DSH_MODULES_ROOT')
  const compiled = defineTool({
    name: 'inline_visual',
    description: DESCRIPTION,
    parameters: AUTHOR_SPEC,
    output: { schema: AUTHOR_OUTPUT, render: () => [] },
    async execute() {
      return { bytes: 0, height: 0 }
    },
  })
  const definition = register()
  assert.deepEqual(definition.parameters, compiled.parameters)
  assert.deepEqual(definition.output.schema, compiled.output.schema)
})

test('returns a compact receipt instead of echoing the markup', async () => {
  const definition = register()
  const value = await definition.execute({ html: '<h1>hi</h1>' }, {})
  assert.deepEqual(value, { bytes: 11, height: 360 })
  assert.equal(JSON.stringify(value).includes('<h1>'), false)
})

test('trims a supplied title and omits an empty one', async () => {
  const definition = register()
  assert.deepEqual(await definition.execute({ html: '<p>x</p>', title: '  Demo  ' }, {}), {
    bytes: 8,
    height: 360,
    title: 'Demo',
  })
  assert.deepEqual(await definition.execute({ html: '<p>x</p>', title: '   ' }, {}), { bytes: 8, height: 360 })
})

test('rounds an accepted height', async () => {
  const definition = register()
  assert.deepEqual(await definition.execute({ html: 'x', height: 500.4 }, {}), { bytes: 1, height: 500 })
})

test('rejects a height outside the supported range', async () => {
  const definition = register()
  await assert.rejects(() => definition.execute({ html: 'x', height: 10 }, {}), /height must be between 120 and 1200/)
  await assert.rejects(() => definition.execute({ html: 'x', height: 5000 }, {}), /height must be between 120 and 1200/)
  await assert.rejects(
    () => definition.execute({ html: 'x', height: Number.NaN }, {}),
    /height must be between 120 and 1200/,
  )
  await assert.rejects(() => definition.execute({ html: 'x', height: '400' }, {}), /"height" to be a number/)
})

test('rejects a visual above the size cap and names the fallback', async () => {
  const definition = register()
  const oversized = 'a'.repeat(MAX_HTML_BYTES + 1)
  await assert.rejects(() => definition.execute({ html: oversized }, {}), /at most 262144 bytes.*present/s)
})

test('accepts a visual exactly at the size cap', async () => {
  const definition = register()
  const value = await definition.execute({ html: 'a'.repeat(MAX_HTML_BYTES) }, {})
  assert.equal(value.bytes, MAX_HTML_BYTES)
})

test('validates arguments locally, because the registry does not', async () => {
  const definition = register()
  await assert.rejects(() => definition.execute({}, {}), /requires "html" to be a string/)
  await assert.rejects(() => definition.execute({ html: 42 }, {}), /requires "html" to be a string/)
  await assert.rejects(() => definition.execute(null, {}), /requires an object argument/)
})

test('renders the model-facing receipt text', () => {
  const definition = register()
  const content = definition.output.render({}, { bytes: 2048, height: 360 })
  assert.deepEqual(content, [{ type: 'text', text: 'Rendered an inline visual (2048 bytes).' }])
})
