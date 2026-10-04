/**
 * Client half of the `dsh-inline-visual` plugin.
 *
 * Two registrations, two jobs:
 *
 * 1. `tool.call.toolview`, keyed by the `inline_visual` wire name, renders the
 *    call itself as one compact row — label, title, size, and any failure. The
 *    retired `html_artifact` name keeps its own key, because tool names are
 *    durable: calls recorded before the rename must keep their row.
 * 2. `conversation.chat.turnTail`, below the closing message of a completed
 *    Turn, renders the visuals themselves. That is the final-response area
 *    rather than the process area, and it rebuilds from durable session state,
 *    so visuals survive a reload.
 *
 * A frame starts at the height the call asked for and then fits the visual's
 * own content, which the visual measures from inside the sandbox and reports to
 * the parent. A frame that held one fixed height would pad a short visual with
 * blank space.
 *
 * The tail reads its turn's Tool-call view nodes through the owner's turn data
 * source and takes each node's root block — the same block shape the toolview
 * receives. Nothing is cached between the two registrations.
 *
 * Security boundary: the frame carries exactly `sandbox="allow-scripts"`, with
 * no `allow-same-origin`, so it lands in an opaque origin and cannot reach the
 * application DOM, its origin storage, or the app's session data. A restrictive
 * Content-Security-Policy is injected into the document to block network
 * access, external resources, forms, and nested frames.
 *
 * The bundle is hand-written against the documented module-loader contract, so
 * it needs no build step: it registers a factory and runs only when the browser
 * materializes the module.
 */
window.__ModuleLoader__.load({
  id: 'dsh-inline-visual',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    /** Locale namespace owned by this plugin. */
    const NS = 'inlineVisual'

    /** Service dependencies of this client plugin. */
    const inject = ['slots', 'locale', 'sessions', 'uiConversation']

    /** Wire Tool name this plugin owns. */
    const TOOL_NAME = 'inline_visual'

    /** Retired wire name, kept so calls already recorded in session logs render. */
    const LEGACY_TOOL_NAME = 'html_artifact'

    /** Mirror of the host cap; a larger visual is not rendered inline. */
    const MAX_RENDER_BYTES = 256 * 1024

    /** Frame height used until the visual reports its own. */
    const DEFAULT_HEIGHT = 360

    /** Smallest frame a call may ask for, in CSS pixels. */
    const MIN_HEIGHT = 120

    /** Largest frame, whether asked for or fitted to content, in CSS pixels. */
    const MAX_HEIGHT = 1200

    /** Smallest frame the renderer fits content into, in CSS pixels. */
    const MIN_FIT_HEIGHT = 32

    /** How long a frame stays out of sight waiting for its first height report, in milliseconds. */
    const REVEAL_TIMEOUT_MS = 1500

    /** Message type a rendered visual uses to report its content height. */
    const HEIGHT_MESSAGE = 'dsh-inline-visual:height'

    /**
     * Content-Security-Policy for every rendered visual. `connect-src 'none'`
     * stops exfiltration; the remaining sources admit only inline content and
     * data/blob assets, so a document cannot load or contact anything remote.
     */
    const CSP =
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
      "img-src data: blob:; font-src data:; media-src data: blob:; " +
      "connect-src 'none'; form-action 'none'; base-uri 'none'"

    const META_CSP = '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">'

    /** Baseline document styling so a bare fragment stays readable in both themes. */
    const BASE_STYLE =
      '<style>:root{color-scheme:light dark}html,body{background:transparent}' +
      'body{margin:0;padding:12px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}</style>'

    /**
     * Height reporter injected into every visual. It measures the document's own
     * content and tells the parent how tall the visual really is, so the frame
     * fits the content instead of guessing. It re-measures after fonts load and
     * whenever the content resizes, because a visual may draw or expand later.
     *
     * The document element is deliberately not measured: it fills the frame, so
     * its scroll height can never report a shrink.
     *
     * A report must never fall short of the content. Content height is often
     * fractional — 13px text at 1.5 line height is 19.5px a line — and the
     * frame is an integer, so rounding to nearest leaves a fraction of a pixel
     * over. The browser then draws a scrollbar that has almost nothing to
     * scroll, which reads as a defect. Two guards prevent it: the report rounds
     * up, and any overflow the document still shows is added to the ask and
     * kept, so the frame never shrinks back into its own scrollbar.
     *
     * Once a report has gone out, a document that fits hides its own scrollbar
     * outright. The frame is about to be exactly as tall as the content, so
     * there is nothing left to scroll, and no future rounding or environment
     * difference can put a bar on a visual that has no use for one. A document
     * taller than the cap keeps its scrollbar: that content genuinely does not
     * fit, and hiding the bar would hide the content with it.
     *
     * The parent checks the sender, so a sibling frame cannot resize this one.
     */
    const MEASURE_SCRIPT =
      '<script>(function(){' +
      'var last=-1,pad=0;' +
      'function measure(){var body=document.body;if(!body)return 0;' +
      'var doc=document.documentElement;var over=doc.scrollHeight-doc.clientHeight;' +
      'if(over>0)pad=Math.min(4,Math.max(pad,over));' +
      'return Math.max(body.scrollHeight,body.offsetHeight)+pad}' +
      'function send(){var height=Math.ceil(measure());' +
      'document.documentElement.style.overflowY=height>' + String(MAX_HEIGHT) + '?"auto":"hidden";' +
      'if(!(height>0)||height===last)return;last=height;' +
      'parent.postMessage({type:' + JSON.stringify(HEIGHT_MESSAGE) + ',height:height},"*")}' +
      'function watch(){send();' +
      'if(typeof ResizeObserver==="function"){var observer=new ResizeObserver(send);' +
      'observer.observe(document.documentElement);if(document.body)observer.observe(document.body)}' +
      'window.addEventListener("resize",send);window.addEventListener("load",send);' +
      'setTimeout(send,400);setTimeout(send,1500)}' +
      'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",watch);else watch()' +
      '})()<\/script>'

    const en = {
      'label': 'Inline visual',
      'preparing': 'Preparing visual…',
      'receiving': 'Receiving visual…',
      'unavailable': 'This call recorded no renderable visual.',
      'failed': 'The visual call failed.',
      'tooLarge': 'This visual is too large to render inline.',
      'below': 'rendered below',
    }

    const zh = {
      'label': '内联可视化',
      'preparing': '正在准备可视化…',
      'receiving': '正在接收可视化…',
      'unavailable': '该调用没有可渲染的可视化。',
      'failed': '可视化调用失败。',
      'tooLarge': '该可视化过大，无法内联渲染。',
      'below': '在下方显示',
    }

    /**
     * Wrap one visual in a complete document that carries the policy, the
     * baseline styling, and the height reporter. An existing `<head>` is reused;
     * otherwise one is made.
     *
     * @param html - model-authored markup, trusted only inside the sandboxed frame.
     * @returns the document text for the frame's `srcdoc`.
     */
    function buildDocument(html) {
      const head = '<meta charset="utf-8">' + META_CSP + BASE_STYLE + MEASURE_SCRIPT
      if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, '<head$1>' + head)
      if (/<html[\s>]/i.test(html)) return html.replace(/<html([^>]*)>/i, '<html$1><head>' + head + '</head>')
      return '<!DOCTYPE html><html><head>' + head + '</head><body>' + html + '</body></html>'
    }

    /**
     * Parse one tool call's raw argument string.
     *
     * Arguments stream in fragments, so a partial or malformed string is an
     * ordinary state, not an error.
     *
     * @param raw - the recorded `argsRaw` value, if any.
     * @returns the parsed arguments carrying an `html` string, or null.
     */
    function parseArgs(raw) {
      if (typeof raw !== 'string' || raw.length === 0) return null
      let value
      try {
        value = JSON.parse(raw)
      } catch (_malformed) {
        return null
      }
      if (typeof value !== 'object' || value === null || typeof value.html !== 'string') return null
      return value
    }

    /**
     * Read the call head of a Tool block, whichever stage it is in.
     *
     * A settled `tool-result` block nests the head under `call`; a preparing or
     * started block is the head itself.
     *
     * @param block - Tool block from the toolview owner or a view node's `data.root`.
     * @returns the wire name and raw argument string, or null.
     */
    function callHead(block) {
      if (typeof block !== 'object' || block === null) return null
      const head = block.kind === 'tool-result' ? block.call : block
      if (typeof head !== 'object' || head === null) return null
      return { name: head.name, argsRaw: head.argsRaw }
    }

    /**
     * Decide whether a recorded Tool name belongs to this plugin.
     *
     * @param wire - the wire name recorded on a Tool call.
     * @returns whether this plugin renders that call.
     */
    function isVisualCall(wire) {
      return wire === TOOL_NAME || wire === LEGACY_TOOL_NAME
    }

    /**
     * Read one entry's visual arguments.
     *
     * The turn data source publishes each node's `data`, not the node itself, so
     * the root Tool block sits at the top level of every entry.
     *
     * @param data - one entry from the turn data source.
     * @returns parsed arguments for a visual call, or null.
     */
    function visualArgs(data) {
      if (typeof data !== 'object' || data === null) return null
      const head = callHead(data.root)
      if (head === null || !isVisualCall(head.name)) return null
      return parseArgs(head.argsRaw)
    }

    /**
     * Read the Turn number a Tail owner passes down.
     *
     * The owner sends its Turn location record, whose own `turn` field is the
     * number; a bare number is accepted too, so neither shape can silently
     * address the wrong Turn.
     *
     * @param turn - the Tail owner's `turn` prop, or the keyed hook's key.
     * @returns the finite Turn number, or undefined for any other shape.
     */
    function turnNumberOf(turn) {
      if (typeof turn === 'number') return Number.isFinite(turn) ? turn : undefined
      if (typeof turn !== 'object' || turn === null) return undefined
      const value = turn.turn
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    }

    /**
     * Read the failure text of a settled call, preferring the recorded error.
     *
     * @param block - the settled `tool-result` block.
     * @returns displayable failure text, or an empty string.
     */
    function failureText(block) {
      const error = block === null || block === undefined ? undefined : block.error
      if (typeof error === 'object' && error !== null) {
        if (typeof error.message === 'string' && error.message.trim() !== '') return error.message.trim()
        if (typeof error.name === 'string' && error.name.trim() !== '') return error.name.trim()
      }
      const content = block !== null && block !== undefined && Array.isArray(block.content) ? block.content : []
      return content
        .filter((item) => typeof item === 'object' && item !== null && item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('\n')
        .trim()
    }

    /**
     * Format a byte count for a metadata label.
     *
     * @param bytes - UTF-8 byte length.
     * @returns a short human-readable size.
     */
    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    }

    /**
     * Measure one visual in UTF-8 bytes.
     *
     * @param html - the visual markup.
     * @returns the byte length.
     */
    function byteLength(html) {
      return new TextEncoder().encode(html).length
    }

    /**
     * Read one visual's title, if the call supplied a usable one.
     *
     * @param args - parsed call arguments.
     * @returns the trimmed title, or an empty string.
     */
    function titleOf(args) {
      return args !== null && typeof args.title === 'string' ? args.title.trim() : ''
    }

    /**
     * Bind the slot-supplied translator, falling back to English when the
     * locale share is unavailable.
     *
     * @param t - translator supplied through the registration's locale.
     * @returns a translator that always answers.
     */
    function translator(t) {
      if (typeof t === 'function') return t
      return (key) => (Object.prototype.hasOwnProperty.call(en, key) ? en[key] : key)
    }

    /**
     * Injected stylesheet, tagged so a reload replaces rather than duplicates it.
     *
     * The frame edge is an outline, never a border. The app applies
     * `* { box-sizing: border-box }`, so a border would come out of the frame's
     * own height and leave the visual's viewport one pixel shorter than the
     * height this plugin measured — a scrollbar with nothing to scroll.
     */
    const CSS_TAG = 'dsh-inline-visual/visual.module.css'
    const CSS =
      '.dshiv_row{display:flex;align-items:center;gap:8px;min-width:0;height:24px;color:var(--dsw-alias-label-tertiary,#8b95ab);font-size:var(--dsh-content-font-size-secondary,13px)}' +
      '.dshiv_label{flex:none;font-weight:600}' +
      '.dshiv_title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#5d6679)}' +
      '.dshiv_note{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.dshiv_meta{flex:none;margin-left:auto;font-variant-numeric:tabular-nums}' +
      '.dshiv_tail{display:flex;flex-direction:column;gap:14px}' +
      '.dshiv_visual{display:flex;flex-direction:column;gap:6px}' +
      '.dshiv_head{display:flex;align-items:center;gap:8px;min-width:0;height:22px;color:var(--dsw-alias-label-tertiary,#8b95ab);font-size:var(--dsh-content-font-size-secondary,13px)}' +
      '.dshiv_frame{display:block;width:100%;border:0;outline:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));outline-offset:-.5px;border-radius:var(--dsw-radius-lg,12px)}' +
      '.dshiv_noteBlock{color:var(--dsw-alias-label-tertiary,#8b95ab);font-size:var(--dsh-content-font-size-secondary,13px);padding:6px 0}'

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-inline-visual'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * Render one `inline_visual` call as a single compact transcript row.
     *
     * The visual itself renders in the Turn tail, so this row states what the
     * call carried and defers the frame; a failed call keeps its own failure
     * text, because the tail renders only visuals that rendered.
     *
     * @param props - Tool owner props plus this registration's locale seat.
     * @returns the compact row.
     */
    function VisualRow(props) {
      const t = translator(props.t)
      const block = props.block === null || props.block === undefined ? null : props.block
      const settled = props.phase === 'result'
      const failed = settled && block !== null && block.isError === true
      const head = callHead(block)
      const args = head === null ? null : parseArgs(head.argsRaw)
      const wire = typeof props.toolName === 'string' ? props.toolName : TOOL_NAME

      let note
      if (failed) {
        note = failureText(block)
        if (note === '') note = t('failed')
      } else if (args !== null) {
        note = t('below')
      } else if (props.phase === 'preparing') {
        note = t('preparing')
      } else if (settled) {
        note = t('unavailable')
      } else {
        note = t('receiving')
      }

      const title = titleOf(args)
      return React.createElement(
        'div',
        { className: 'dshiv_row', 'data-tool': wire, 'data-state': props.phase },
        React.createElement('span', { className: 'dshiv_label' }, t('label')),
        title === '' ? null : React.createElement('span', { className: 'dshiv_title' }, title),
        React.createElement('span', { className: 'dshiv_note' }, note),
        args === null ? null : React.createElement('span', { className: 'dshiv_meta' }, formatBytes(byteLength(args.html))),
      )
    }

    /**
     * Read a height a visual reported from inside its frame.
     *
     * The report comes from untrusted markup, so anything that is not a finite
     * positive number is discarded rather than trusted.
     *
     * @param data - the message payload, of any shape.
     * @returns the reported height in CSS pixels, or null.
     */
    function reportedHeight(data) {
      if (typeof data !== 'object' || data === null || data.type !== HEIGHT_MESSAGE) return null
      const value = Number(data.height)
      return Number.isFinite(value) && value > 0 ? value : null
    }

    /**
     * Choose the frame height: the visual's own report once there is one, and
     * the requested height until then.
     *
     * A report may shrink the frame below the request, which is the point: blank
     * space under a short visual is a defect. A requested height never shrinks
     * below the documented minimum.
     *
     * @param measured - the height the visual reported, or null.
     * @param requested - the height the call asked for.
     * @returns the frame height in CSS pixels.
     */
    function frameHeight(measured, requested) {
      const wanted = measured === null ? requested : measured
      const floor = measured === null ? MIN_HEIGHT : MIN_FIT_HEIGHT
      return Math.min(MAX_HEIGHT, Math.max(floor, Math.ceil(wanted)))
    }

    /**
     * Render one visual: a small header, then the sandboxed frame.
     *
     * The frame starts at the requested height and then fits whatever the visual
     * reports, so there is no expand control and no blank space under a short
     * visual. A visual taller than the maximum scrolls inside its own frame.
     *
     * @param props - parsed call arguments and the translator.
     * @returns the visual block.
     */
    function VisualFrame({ args, t }) {
      const frame = React.useRef(null)
      const [reported, setReported] = React.useState(null)
      const [revealed, setRevealed] = React.useState(false)

      React.useEffect(() => {
        function onMessage(event) {
          const element = frame.current
          if (element === null || element === undefined || event.source !== element.contentWindow) return
          const value = reportedHeight(event.data)
          if (value !== null) setReported(value)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])

      /**
       * Hold the frame out of sight until its height is settled, then show it.
       *
       * The first paint uses the height the call asked for, which is a guess; the
       * fitted height arrives a moment later. Showing the guess means the reader
       * watches the visual resize, and anything drawn inside it repaints at the
       * new size. Waiting costs nothing visible, because the fit lands quickly.
       *
       * Visibility is hidden rather than `display: none`: a frame with no layout
       * measures zero, and the reporter inside it would report nothing.
       *
       * A frame that never reports is shown anyway, so a visual is never lost to
       * a missing report.
       */
      React.useEffect(() => {
        if (reported !== null) {
          setRevealed(true)
          return undefined
        }
        const timer = setTimeout(() => setRevealed(true), REVEAL_TIMEOUT_MS)
        return () => clearTimeout(timer)
      }, [reported])

      const html = args.html
      const bytes = byteLength(html)
      const tooLarge = bytes > MAX_RENDER_BYTES
      const title = titleOf(args)
      const requested = typeof args.height === 'number' ? Math.round(args.height) : DEFAULT_HEIGHT
      const height = frameHeight(reported, requested)

      const head = React.createElement(
        'div',
        { className: 'dshiv_head' },
        React.createElement('span', { className: 'dshiv_label' }, t('label')),
        title === '' ? null : React.createElement('span', { className: 'dshiv_title' }, title),
        React.createElement('span', { className: 'dshiv_meta' }, formatBytes(bytes)),
      )

      const body = tooLarge
        ? React.createElement('div', { className: 'dshiv_noteBlock' }, t('tooLarge'))
        : React.createElement('iframe', {
            ref: frame,
            className: 'dshiv_frame',
            style: { height: height + 'px', visibility: revealed ? 'visible' : 'hidden' },
            sandbox: 'allow-scripts',
            referrerPolicy: 'no-referrer',
            srcDoc: buildDocument(html),
            title: title === '' ? t('label') : title,
          })

      return React.createElement('div', { className: 'dshiv_visual' }, head, body)
    }

    /**
     * Render every visual of one completed Turn, beneath its closing message.
     *
     * @param props - Turn tail owner props plus this registration's keyed hook and locale.
     * @returns the visuals, or null when the Turn produced none.
     */
    function TurnVisuals({ turn, useVisuals, t }) {
      const number = turnNumberOf(turn)
      const key = number === undefined ? undefined : String(number)
      const entries = typeof useVisuals === 'function' ? useVisuals(key) : undefined
      if (!Array.isArray(entries) || entries.length === 0) return null

      const visuals = []
      for (let index = 0; index < entries.length; index++) {
        const data = entries[index]
        const args = visualArgs(data)
        if (args === null) continue
        const root = data.root
        const callId = typeof root.callId === 'string' ? root.callId : String(index)
        visuals.push(React.createElement(VisualFrame, { key: callId, args, t: translator(t) }))
      }
      if (visuals.length === 0) return null
      return React.createElement('div', { className: 'dshiv_tail', 'data-inline-visuals': visuals.length }, visuals)
    }

    /**
     * Client plugin body: own the locale dictionary, the keyed Tool row, and the
     * Turn-tail visual area.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'inline-visual: dictionaries')

      for (const wire of [TOOL_NAME, LEGACY_TOOL_NAME]) {
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register(
            {
              name: 'tool.call.toolview',
              key: wire,
              locale: NS,
            },
            VisualRow,
          ),
        )
      }

      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: 'inline-visual',
            order: 20,
            locale: NS,
            inject: (sessionId) => {
              const binding = ctx.sessions.binding(sessionId)
              if (binding === undefined) throw new Error(`inline-visual: unknown session "${sessionId}"`)
              const chat = ctx.uiConversation.binding(binding).target('chat')
              return {
                keyedHooks: {
                  visuals: (key) => {
                    const raw = typeof key === 'string' && key.trim() !== '' ? Number(key) : key
                    const turn = turnNumberOf(raw)
                    if (turn === undefined) return undefined
                    const snapshot = chat.getSnapshot()
                    const nodes = snapshot === null || snapshot === undefined ? undefined : snapshot.nodes
                    if (nodes === undefined || typeof nodes.turnDataSource !== 'function') return undefined
                    return nodes.turnDataSource(turn, 'tool-call')
                  },
                },
              }
            },
          },
          TurnVisuals,
        ),
      )
    }

    /**
     * Pure helpers exposed for the test suite only. The application reads
     * `apply` and `inject`, and nothing else.
     */
    exports.__internals = { buildDocument, css: CSS, frameHeight, reportedHeight }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
