/**
 * Shared test support: locate the DSH installation and a React build, copy the
 * package into a throwaway sandbox, and load the client bundle the way the
 * browser module loader does.
 *
 * The host half imports `@deepseek-ai/dsh-tools` by bare specifier. Node cannot
 * read the packaged `app.asar`, so these tests run against an extracted copy of
 * the installation, pointed at by `DSH_MODULES_ROOT`.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const packageRoot = resolve(here, '..')

/** Candidate locations of an extracted `node_modules` holding the DSH packages. */
export const DSH_MODULE_ROOTS = [process.env.DSH_MODULES_ROOT, '/tmp/dshfull/dsh/node_modules'].filter(
  (value) => typeof value === 'string' && value !== '',
)

/** Candidate locations of a React build, used only to render the client row. */
export const REACT_ROOTS = [
  process.env.DSH_REACT_ROOT,
  join(packageRoot, 'node_modules'),
  '/opt/homebrew/lib/node_modules',
].filter((value) => typeof value === 'string' && value !== '')

/**
 * Resolve one specifier against the first root that can answer it.
 *
 * @param roots - candidate `node_modules` directories.
 * @param spec - bare or relative specifier to resolve.
 * @param label - environment variable named in the failure message.
 * @returns the root that answered and the resolved absolute path.
 */
export function resolveFirst(roots, spec, label) {
  for (const root of roots) {
    if (!existsSync(root)) continue
    const require = createRequire(join(root, 'noop.js'))
    try {
      return { root, path: require.resolve(spec) }
    } catch (_unresolved) {
      // Try the next candidate root.
    }
  }
  throw new Error(`cannot resolve "${spec}"; set ${label} to a directory that provides it`)
}

/**
 * Load one package from the first root that provides it.
 *
 * @param roots - candidate `node_modules` directories.
 * @param spec - specifier to load.
 * @param label - environment variable named in the failure message.
 * @returns the loaded module.
 */
export function requireFirst(roots, spec, label) {
  const { path } = resolveFirst(roots, spec, label)
  return createRequire(import.meta.url)(path)
}

/**
 * Copy the package under test into a private directory whose `node_modules`
 * links to the extracted installation, so bare imports resolve without
 * publishing or installing anything.
 *
 * @returns the sandbox directory, the installation root if one was found, and a cleanup function.
 */
export function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inline-visual-'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  cpSync(join(packageRoot, 'lib', 'index.js'), join(dir, 'lib', 'index.js'))
  cpSync(join(packageRoot, 'lib', 'client.js'), join(dir, 'lib', 'client.js'))
  cpSync(join(packageRoot, 'package.json'), join(dir, 'package.json'))

  const dshRoot = DSH_MODULE_ROOTS.find((root) => existsSync(root))
  if (dshRoot !== undefined) symlinkSync(dshRoot, join(dir, 'node_modules'), 'dir')

  return {
    dir,
    dshRoot,
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Import one file with a cache-busting query so repeated runs re-evaluate it.
 *
 * @param file - absolute path of a module.
 * @returns the module namespace.
 */
export function importFile(file) {
  return import(pathToFileURL(file).href + '?v=' + Date.now())
}

/**
 * Load a client bundle exactly as the browser kernel does: publish a
 * `window.__ModuleLoader__` facade, evaluate the bundle, then run its factory
 * against a supplied `require`.
 *
 * @param file - absolute path of the built client bundle.
 * @param requireImpl - the module request implementation the factory receives.
 * @returns the registered bundle id and the factory's exports.
 */
export async function loadBundle(file, requireImpl) {
  let entry = null
  const previous = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        entry = value
      },
    },
  }
  try {
    await importFile(file)
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
  if (entry === null) throw new Error('the bundle did not call window.__ModuleLoader__.load')
  return { id: entry.id, exports: entry.factory(requireImpl) }
}
