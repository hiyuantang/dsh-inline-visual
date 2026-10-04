# dsh-inline-visual

Render model-authored inline visuals **in the final response** of a DSH turn.

The plugin adds one tool, `inline_visual`. When the agent calls it, the visual
renders as a sandboxed frame beneath the closing message of that turn — the
response area — rather than in the process area or the right Sidebar. The name
matches the wording agent instructions already use: use inline interactive
visuals when they explain something better than prose.

## What it does

- **Host half** (`lib/index.js`) registers the `inline_visual` tool with the DSH
  tool registry. It accepts `html` (required), `title`, and `height`, caps the
  markup at 256 KiB, and returns a short receipt so the model never reads the
  markup back.
- **Client half** (`lib/client.js`) makes two registrations:
  - `tool.call.toolview`, keyed by the `inline_visual` wire name, renders the
    call itself as one compact row — label, title, size, and any failure.
  - `conversation.chat.turnTail` renders the visuals themselves, beneath the
    closing message of a completed turn, each in a frame that fits its content.

### Frame sizing

A frame starts at the height the call asked for, then fits the visual's own
content. Every rendered document carries a small reporter that measures
`document.body` and posts the height to the parent. The parent accepts a report
only from that frame, clamps it to 32–1200 px, and re-renders. A short visual
therefore loses its blank space, and a visual taller than the maximum scrolls
inside its own frame.

There is no expand control. The frame is already as tall as its content, so the
only thing a control could add is blank space.

A fit must never fall short. Content height is often fractional — 13px text at
1.5 line height is 19.5px a line — so the reporter rounds its measurement up and
adds any overflow the document still reports. The frame's edge is drawn with an
outline rather than a border, because the app applies
`* { box-sizing: border-box }`: a border would come out of the frame's own height
and leave the visual's viewport a pixel short, which the browser answers with a
scrollbar that has nothing to scroll.

The reporter is injected into the document head ahead of the model's own markup,
so it runs before any `<meta>` policy that document declares takes effect. A
document's own CSP therefore does not stop the fit. Only a policy inherited from
the embedding page can, and the frame then keeps the requested height.

### The retired name

The tool was called `html_artifact` before the rename. Tool names are recorded
in durable session logs, so the client half still claims that name: it registers
a second `tool.call.toolview` key and matches the tail against both names. Calls
written by older sessions keep their compact row and their frame; the row
attributes itself to the name the call actually recorded. Nothing else accepts
the old name — the model only ever sees `inline_visual`.

## Why the visual lives in the Turn tail

A tool row sits in the process area, above the reply. The `turnTail` seat is the
response area, and it has a second advantage: it rebuilds from durable session
state rather than from anything captured while streaming, so visuals survive a
reload.

The tail asks its own turn for its Tool-call view nodes through the owner's turn
data source, then takes each node's `data.root` block — the same block shape the
toolview receives. The owner passes its Turn location record, whose own `turn`
field is the number, so the hook keys on `String(turn.turn)`:

```js
keyedHooks: {
  visuals: (key) => {
    const turn = turnNumberOf(typeof key === 'string' ? Number(key) : key)
    if (turn === undefined) return undefined
    return chat.getSnapshot().nodes.turnDataSource(turn, 'tool-call')
  },
}
```

The hook answers `undefined` instead of throwing when the key is not a Turn or
the Chat target is not readable yet. A Slot entry that throws is retired for the
rest of its registration's life, which is a silent blank tail; a missing answer
only blanks the visuals of that one render.

Nothing is cached between the two registrations, so a replayed transcript and a
live one take the same path.

## Security model

Model output is untrusted. Every visual is rendered with:

- `sandbox="allow-scripts"` and **no** `allow-same-origin`, so the frame lands in
  an opaque origin. It cannot read the application DOM, its storage, its
  session, or its cookies.
- No `allow-top-navigation`, `allow-forms`, or `allow-popups`.
- An injected `Content-Security-Policy`: `default-src 'none'`,
  `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, with images,
  fonts, and media limited to `data:` and `blob:`. A visual can run scripts, but
  it cannot reach the network or load anything remote.
- `referrerpolicy="no-referrer"`.

This mirrors the policy the Sidebar's interactive HTML preview already uses.

## Install

### From the repository

DSH installs a plugin from a package name, a Git repository address, or a local
directory path. In the Web sidebar, open **Plugins**, choose **Add plugin**, and
enter this repository's address:

```
https://github.com/hiyuantang/dsh-inline-visual
```

DSH runs `pnpm add` in the profile directory, reads the installed `package.json`,
and applies the bundle patch. `cordis.patch.yml` inserts one row,
`inline-visual`, named after the package, so the entry resolves from the
profile's `node_modules` instead of an absolute path.

The package must declare `dsh.bundle.patch` for this to work. Without it DSH
refuses the install with `not-a-bundle` and restores the profile manifest, so a
Git repository that is an ordinary npm package cannot install this way.

Upgrading is uninstall and reinstall, because the profile records a Git address
rather than a version range.

### From a file path

Point a profile row at this package's **entry file**. The name may be an
absolute path, so no publish, registry, or `pnpm install` is involved:

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- insert:
    - id: inline-visual
      name: /absolute/path/to/dsh-inline-visual/lib/index.js
```

Two rules matter here, and both were established by experiment:

- **Name the file, not the directory.** A profile row is an ES module import, and
  Node refuses a directory import (`ERR_UNSUPPORTED_DIR_IMPORT`). Naming
  `lib/index.js` also lets the client half find this package's `package.json`,
  which it walks up to from the resolved module.
- **The host half imports nothing, and must keep importing nothing.** An
  out-of-tree row is not admitted to the launcher's runtime package lookup, so a
  bare `@deepseek-ai/*` import in `lib/index.js` fails at mount time with
  `Cannot find package`. The definition is therefore written directly against
  the registry contract. A test asserts that the file contains no import
  statements, and another proves the hand-written schemas are identical to what
  `defineTool` compiles, so nothing was lost by dropping the helper.

Profile configuration reloads by default, so the row applies to a running app.
The tool appears in the next session's tool list.

### Verifying a change before it goes live

Use a real boot, not a schema dump. `--dump-config-schema` installs its own
resolution interception while it imports composed modules, so it can import a row
that the launcher then fails to activate. A stdio profile boots the real mount
path and needs no model call:

```sh
DSH_HOME=/tmp/dshprobe dsh acpprobe --from-default-profile acp \
  --patch ./row.yml < /dev/null
```

A healthy boot prints nothing. A row that fails prints
`<id> (<url>): failed to import` plus `1 entry did not activate`.

## Use

The agent calls it directly:

```json
{
  "html": "<!DOCTYPE html><html><body><h1>Hello</h1></body></html>",
  "title": "Greeting",
  "height": 240
}
```

`height` is the starting height, not the final one: give the visual room to
appear before it reports its own size.

The parameter stays `html`, because that is what it carries: one complete HTML
document. Guidance worth putting in `AGENTS.md`:

> Use `inline_visual` when a small interactive visualization, diagram, or chart
> explains something better than prose. Pass one self-contained document;
> external resources and network access are blocked. For a large or reusable
> visual, write an `.html` file and deliver it with `present` instead.

## Tests

```sh
npm install
npm test
```

The suite covers both halves: the tool definition, argument validation, the size
and height limits, and the receipt text; plus the bundle contract, both keyed
registrations, the retired-name fallback, the sandbox attribute, the injected
policy, document wrapping, the height reporter and its clamps, the absence of an
expand control, and every lifecycle state (preparing, streaming arguments,
settled, failed, oversized).

Two environment facts the tests need:

- `DSH_MODULES_ROOT` — a `node_modules` directory holding the DSH packages
  (`@deepseek-ai/dsh-tools`). Node cannot read the packaged `app.asar`, so point
  this at an extracted copy of the installation. Defaults to
  `/tmp/dshfull/dsh/node_modules`.
- `DSH_REACT_ROOT` — optional; the tests use the local `react` dev dependency
  first, then a global install.

The client row is rendered with the same React major the app ships (18.2), so
attribute output matches the browser.

## Limits

- 256 KiB per visual, in the tool and in the renderer.
- Visuals live in the transcript as tool arguments, so large documents cost
  tokens and durable log space. Use a file plus `present` above that size.
- The frame fits its content down to 32 px and up to 1200 px; a taller visual
  scrolls inside its own frame.
- A visual's own policy cannot stop the fit. The reporter is injected ahead of
  the document's own markup, so it runs before any `<meta>` policy that document
  declares takes effect. Four frames were measured against this: none, `script-src
  'none'`, `default-src 'none'`, and a `sandbox` directive all reported their
  height. A policy inherited from the embedding page is the case that would block
  the report; the frame then keeps the requested height.
- No file, network, or storage access inside the frame — that is the point.
