/* eslint-disable no-console */
import { dirname, isAbsolute, join, parse } from 'path'
import { createRequire } from 'module'
import { blue, cyan, dim, gray, green, red, yellow } from 'kolorist'
import fs from 'fs-extra'
import type { ResolvedConfig } from 'vite'
import { resolveConfig, build as viteBuild } from 'vite'
import type { SSRContext } from 'vue/server-renderer'
import { JSDOM } from 'jsdom'
import type { RollupOutput } from 'rollup'
import type { VitePluginPWAAPI } from 'vite-plugin-pwa'
import type { RouteRecordRaw } from 'vue-router'
import type { ViteSSGContext, ViteSSGOptions } from '../types'
import { serializeState } from '../utils/state'
import { renderPreloadLinks } from './preload-links'
import { buildLog, getSize, routesToPaths } from './utils'
import { getCritters } from './critical'

export type Manifest = Record<string, string[]>

export type CreateAppFactory = (client: boolean, routePath?: string) => Promise<ViteSSGContext<true> | ViteSSGContext<false>>

function DefaultIncludedRoutes(paths: string[], routes: RouteRecordRaw[]) {
  // ignore dynamic routes
  return paths.filter(i => !i.includes(':') && !i.includes('*'))
}

function readJson(path: string) {
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}

export async function build(cliOptions: Partial<ViteSSGOptions> = {}) {
  const mode = process.env.MODE || process.env.NODE_ENV || cliOptions.mode || 'production'
  const config = await resolveConfig({}, 'build', mode)

  const cwd = process.cwd()
  const root = config.root || cwd
  const ssgOut = join(root, '.vite-ssg-temp')
  const outDir = config.build.outDir || 'dist'
  const out = isAbsolute(outDir) ? outDir : join(root, outDir)

  const {
    script = 'sync',
    mock = false,
    entry = await detectEntry(root),
    formatting = 'none',
    crittersOptions = {},
    includedRoutes: configIncludedRoutes = DefaultIncludedRoutes,
    onBeforePageRender,
    onPageRendered,
    onFinished,
    dirStyle = 'flat',
    includeAllRoutes = false,
    format = 'esm',
  }: ViteSSGOptions = Object.assign({}, config.ssgOptions || {}, cliOptions)

  if (fs.existsSync(ssgOut))
    await fs.remove(ssgOut)

  // client
  buildLog('Build for client...')
  await viteBuild({
    build: {
      ssrManifest: true,
      rollupOptions: {
        input: {
          app: join(root, './index.html'),
        },
      },
    },
    mode: config.mode,
  }) as RollupOutput

  // server
  buildLog('Build for server...')
  process.env.VITE_SSG = 'true'
  const ssrEntry = await resolveAlias(config, entry)
  await viteBuild({
    build: {
      ssr: ssrEntry,
      outDir: ssgOut,
      minify: false,
      cssCodeSplit: false,
      rollupOptions: {
        output: format === 'esm'
          ? {
            entryFileNames: '[name].mjs',
            format: 'esm',
          }
          : {
            entryFileNames: '[name].cjs',
            format: 'cjs',
          },
      },
    },
    mode: config.mode,
  })

  const prefix = format === 'esm' && process.platform === 'win32' ? 'file://' : ''
  const ext = format === 'esm' ? '.mjs' : '.cjs'
  const serverEntry = join(prefix, ssgOut, parse(ssrEntry).name + ext)

  const _require = createRequire(import.meta.url)

  const { createApp, includedRoutes: serverEntryIncludedRoutes }: { createApp: CreateAppFactory; includedRoutes: ViteSSGOptions['includedRoutes'] } = format === 'esm'
    ? await import(serverEntry)
    : _require(serverEntry)
  const includedRoutes = serverEntryIncludedRoutes || configIncludedRoutes
  const { routes } = await createApp(false)

  let routesPaths = includeAllRoutes
    ? routesToPaths(routes)
    : await includedRoutes(routesToPaths(routes), routes || [])

  // uniq
  routesPaths = Array.from(new Set(routesPaths))

  buildLog('Rendering Pages...', routesPaths.length)

  const critters = crittersOptions !== false ? await getCritters(outDir, crittersOptions) : undefined
  if (critters)
    console.log(`${gray('[vite-ssg]')} ${blue('Critical CSS generation enabled via `critters`')}`)

  if (mock) {
    // @ts-expect-error dynamic import
    const jsdomGlobal = (await import('./jsdomGlobal')).default
    jsdomGlobal()
  }

  const ssrManifest: Manifest = JSON.parse(await fs.readFile(join(out, 'ssr-manifest.json'), 'utf-8'))
  let indexHTML = await fs.readFile(join(out, 'index.html'), 'utf-8')
  indexHTML = rewriteScripts(indexHTML, script)

  const { renderToString }: typeof import('vue/server-renderer') = format === 'esm'
    ? await import('vue/server-renderer')
    : _require('vue/server-renderer')

  await Promise.all(
    routesPaths.map(async(route) => {
      try {
        const appCtx = await createApp(false, route) as ViteSSGContext<true>
        const { app, router, head, initialState, triggerOnSSRAppRendered, transformState = serializeState } = appCtx

        if (router) {
          await router.push(route)
          await router.isReady()
        }

        const transformedIndexHTML = (await onBeforePageRender?.(route, indexHTML, appCtx)) || indexHTML

        const ctx: SSRContext = {}
        const appHTML = await renderToString(app, ctx)
        await triggerOnSSRAppRendered?.(route, appHTML, appCtx)
        // need to resolve assets so render content first
        const renderedHTML = await renderHTML({ indexHTML: transformedIndexHTML, appHTML, initialState: transformState(initialState) })

        // create jsdom from renderedHTML
        const jsdom = new JSDOM(renderedHTML)

        // render current page's preloadLinks
        renderPreloadLinks(jsdom.window.document, ctx.modules || new Set<string>(), ssrManifest)

        // render head
        head?.updateDOM(jsdom.window.document)

        const html = jsdom.serialize()
        let transformed = (await onPageRendered?.(route, html, appCtx)) || html
        if (critters)
          transformed = await critters.process(transformed)

        const formatted = await formatHtml(transformed, formatting)

        const relativeRouteFile = `${(route.endsWith('/')
          ? `${route}index`
          : route).replace(/^\//g, '')}.html`

        const filename = dirStyle === 'nested'
          ? join(route.replace(/^\//g, ''), 'index.html')
          : relativeRouteFile

        await fs.ensureDir(join(out, dirname(filename)))
        await fs.writeFile(join(out, filename), formatted, 'utf-8')
        config.logger.info(
          `${dim(`${outDir}/`)}${cyan(filename.padEnd(15, ' '))}  ${dim(getSize(formatted))}`,
        )
      }
      catch (err: any) {
        throw new Error(`${gray('[vite-ssg]')} ${red(`Error on page: ${cyan(route)}`)}\n${err.stack}`)
      }
    }),
  )

  await fs.remove(ssgOut)

  // when `vite-plugin-pwa` is presented, use it to regenerate SW after rendering
  const pwaPlugin: VitePluginPWAAPI = config.plugins.find(i => i.name === 'vite-plugin-pwa')?.api
  if (pwaPlugin && !pwaPlugin.disabled && pwaPlugin.generateSW) {
    buildLog('Regenerate PWA...')
    await pwaPlugin.generateSW()
  }

  console.log(`\n${gray('[vite-ssg]')} ${green('Build finished.')}`)

  await onFinished?.()

  // ensure build process always exits
  const waitInSeconds = 15
  const timeout = setTimeout(() => {
    console.log(`${gray('[vite-ssg]')} ${yellow(`Build process still running after ${waitInSeconds}s. There might be something misconfigured in your setup. Force exit.`)}`)
    process.exit(0)
  }, waitInSeconds * 1000)
  timeout.unref() // don't wait for timeout
}

async function detectEntry(root: string) {
  // pick the first script tag of type module as the entry
  const scriptSrcReg = /<script(?:.*?)src=["'](.+?)["'](?!<)(?:.*)\>(?:[\n\r\s]*?)(?:<\/script>)/img
  const html = await fs.readFile(join(root, 'index.html'), 'utf-8')
  const scripts = [...html.matchAll(scriptSrcReg)] || []
  const [, entry] = scripts.find((matchResult) => {
    const [script] = matchResult
    const [, scriptType] = script.match(/.*\stype=(?:'|")?([^>'"\s]+)/i) || []
    return scriptType === 'module'
  }) || []
  return entry || 'src/main.ts'
}

async function resolveAlias(config: ResolvedConfig, entry: string) {
  const resolver = config.createResolver()
  const result = await resolver(entry, config.root)
  return result || join(config.root, entry)
}

function rewriteScripts(indexHTML: string, mode?: string) {
  if (!mode || mode === 'sync')
    return indexHTML
  return indexHTML.replace(/<script type="module" /g, `<script type="module" ${mode} `)
}

async function renderHTML({ indexHTML, appHTML, initialState }: { indexHTML: string; appHTML: string; initialState: any }) {
  const stateScript = initialState
    ? `\n<script>window.__INITIAL_STATE__=${initialState}</script>`
    : ''
  if (indexHTML.includes('<div id="app"></div>')) {
    return indexHTML
      .replace(
        '<div id="app"></div>',
        `<div id="app" data-server-rendered="true">${appHTML}</div>${stateScript}`,
      )
  }

  const html5Parser = await import('html5parser')
  const ast = html5Parser.parse(indexHTML)
  const idAttributeValue = 'app'
  let renderedOutput: string | undefined

  html5Parser.walk(ast, {
    enter: (node) => {
      if (!renderedOutput
          && node?.type === html5Parser.SyntaxKind.Tag
          && Array.isArray(node.attributes)
          && node.attributes.length > 0
          && node.attributes.some(attr => attr.name.value === 'id' && attr.value?.value === idAttributeValue)
      ) {
        const attributesStringified = [...node.attributes.map(({ name: { value: name }, value }) => `${name}="${value!.value}"`)].join(' ')
        const indexHTMLBefore = indexHTML.slice(0, node.start)
        const indexHTMLAfter = indexHTML.slice(node.end)
        renderedOutput = `${indexHTMLBefore}<${node.name} ${attributesStringified} data-server-rendered="true">${appHTML}</${node.name}>${stateScript}${indexHTMLAfter}`
      }
    },
  })

  if (!renderedOutput)
    throw new Error(`Could not find a tag with id="${idAttributeValue}" to replace it with server-side rendered HTML`)

  return renderedOutput
}

async function formatHtml(html: string, formatting: ViteSSGOptions['formatting']) {
  if (formatting === 'minify') {
    const htmlMinifier = await import('html-minifier')
    return htmlMinifier.minify(html, {
      collapseWhitespace: true,
      caseSensitive: true,
      collapseInlineTagWhitespace: false,
      minifyJS: true,
      minifyCSS: true,
    })
  }
  else if (formatting === 'prettify') {
    // @ts-expect-error dynamic import
    const prettier = (await import('prettier/esm/standalone.mjs')).default
    // @ts-expect-error dynamic import
    const parserHTML = (await import('prettier/esm/parser-html.mjs')).default

    return prettier.format(html, { semi: false, parser: 'html', plugins: [parserHTML] })
  }
  return html
}
