/**
 * Host half of the `dsh-inline-visual` plugin.
 *
 * Registers one model-facing tool, `inline_visual`, which carries a complete
 * self-contained HTML document in its arguments. The client half of this
 * package renders that call as a sandboxed iframe inside the conversation, so
 * the visual appears inline in the transcript rather than in the Sidebar.
 *
 * The definition is written against the registry contract directly and imports
 * nothing. That is deliberate: a profile row loads by absolute path, and such a
 * row is not admitted to the launcher's runtime package lookup, so an
 * `@deepseek-ai/*` import here would fail to resolve at mount time. Importing
 * nothing means the row loads from any location. The cost is that argument
 * validation is local, because the registry validates only what `defineTool`
 * wraps.
 *
 * The tool returns a short receipt: the recorded tool result is what the model
 * reads back, and re-emitting the markup there would double its token cost.
 *
 * @module dsh-inline-visual
 */

/** Stable Loader identity. */
const name = 'inline-visual'

/** Services used by the scoped visual tool. */
const inject = ['tools']

/** Largest visual the tool accepts, in UTF-8 bytes. */
const MAX_HTML_BYTES = 256 * 1024

/** Frame height used when the call names no `height`. */
const DEFAULT_HEIGHT = 360

/** Smallest accepted frame height, in CSS pixels. */
const MIN_HEIGHT = 120

/** Largest accepted frame height, in CSS pixels. */
const MAX_HEIGHT = 1200

const DESCRIPTION = [
  'Render an inline interactive visual in the conversation.',
  'Use it when a small interactive visualization, diagram, or chart explains something better than prose.',
  'Pass one complete HTML document in `html`. Inline CSS and inline JavaScript both run; the frame is sandboxed with scripts only, so it cannot reach the app, the network, or local storage.',
  'Do not reference external files, fonts, images, or URLs: they are blocked. Keep the markup under 256 KiB.',
  'For a large or reusable visual, write an .html file and deliver it with present instead.',
].join(' ')

/** Model-facing parameter schema, in the compiled JSON Schema form the registry publishes. */
const PARAMETERS = {
  type: 'object',
  properties: {
    html: {
      type: 'string',
      description:
        'The complete HTML document to render. Include a doctype or a full <html> element. Inline styles and scripts only; no external resources.',
    },
    title: {
      type: 'string',
      description: 'Short label shown above the visual. Omit when the visual has no useful title.',
    },
    height: {
      type: 'number',
      description:
        `Initial frame height in CSS pixels, ${MIN_HEIGHT} to ${MAX_HEIGHT}. Defaults to ${DEFAULT_HEIGHT}. ` +
        'The frame then fits the visual content.',
    },
  },
  required: ['html'],
}

/** Structured result schema and its model-facing rendering. */
const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      bytes: { type: 'integer' },
      height: { type: 'integer' },
      title: { type: 'string' },
    },
    required: ['bytes', 'height'],
  },
  render: (_args, value) => [
    {
      type: 'text',
      text: `Rendered an inline visual (${value.bytes} bytes).`,
    },
  ],
}

/**
 * Validate one call and reduce it to the recorded result value.
 *
 * @param args - model-supplied arguments, however malformed.
 * @returns the recorded visual receipt.
 */
function run(args) {
  if (typeof args !== 'object' || args === null) {
    throw new Error('inline_visual requires an object argument carrying an "html" string')
  }

  const html = args.html
  if (typeof html !== 'string') {
    throw new Error('inline_visual requires "html" to be a string')
  }

  const bytes = Buffer.byteLength(html, 'utf8')
  if (bytes > MAX_HTML_BYTES) {
    throw new Error(
      `inline_visual accepts at most ${MAX_HTML_BYTES} bytes of HTML; this visual is ${bytes} bytes. ` +
        'Write it to an .html file and deliver it with present instead.',
    )
  }

  const requested = args.height
  if (requested !== undefined && typeof requested !== 'number') {
    throw new Error('inline_visual requires "height" to be a number when it is present')
  }
  const height = requested === undefined ? DEFAULT_HEIGHT : Math.round(requested)
  if (!Number.isFinite(height) || height < MIN_HEIGHT || height > MAX_HEIGHT) {
    throw new Error(
      `inline_visual height must be between ${MIN_HEIGHT} and ${MAX_HEIGHT} pixels; received ${String(requested)}.`,
    )
  }

  const title = typeof args.title === 'string' ? args.title.trim() : ''
  return title === '' ? { bytes, height } : { bytes, height, title }
}

/** The complete registry-ready definition. */
const tool = {
  name: 'inline_visual',
  description: DESCRIPTION,
  parameters: PARAMETERS,
  output: OUTPUT,
  async execute(args) {
    return run(args)
  },
}

/**
 * Register the `inline_visual` tool.
 *
 * @param ctx - agent-scoped services; `tools` is the registry the definition enters.
 */
function apply(ctx) {
  ctx.tools.register(tool)
}

export { OUTPUT, PARAMETERS, apply, inject, name, run, tool }
