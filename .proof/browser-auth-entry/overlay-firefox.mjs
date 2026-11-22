/** Actual built host + deployed overlay recovery composition; disposable state only. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { selectOverlayBoot } from '../bundles/exo-overlay/lib/boot.js'

const root = resolve(new URL('../..', import.meta.url).pathname)
const requireHost = createRequire(join(root, 'packages/host/frontend-static/package.json'))
const moduleFor = name => import(pathToFileURL(requireHost.resolve(name)).href)
const { Context } = await moduleFor('@deepseek-ai/cordis')
const { default: Loader } = await moduleFor('@deepseek-ai/cordis-plugin-loader')
const { default: Include } = await import(pathToFileURL(join(root, 'vendor/include/lib/index.js')).href)
const Connection = await moduleFor('@deepseek-ai/dsh-client-connection')
const { default: LocalCredentials } = await moduleFor('@deepseek-ai/dsh-credentials-local')
const { default: HttpServer } = await moduleFor('@deepseek-ai/dsh-host-webserver')
const FrontendStatic = await import(pathToFileURL(join(root, 'packages/host/frontend-static/lib/index.js')).href)
const requireWeb = createRequire(join(root, 'apps/web/package.json'))
const { firefox } = requireWeb('playwright')
const proofDir = join(root, '.proof/browser-auth-entry/overlay-firefox')
await mkdir(proofDir, { recursive: true })
const record = { startedAt: new Date().toISOString(), complete: false, checks: [], artifacts: {} }
for (const p of ['packages/client/connection/lib/index.js', 'packages/host/frontend-static/lib/index.js', '.proof/bundles/exo-overlay/lib/boot.js', '.proof/bundles/exo-overlay/lib/entry-recovery.js']) record.artifacts[p] = createHash('sha256').update(await readFile(join(root,p))).digest('hex')
const save = () => writeFile(join(proofDir, 'receipt.json'), JSON.stringify(record,null,2)+'\n')
await save()
const temp = await mkdtemp(join(tmpdir(), 'exo-entry-composed-'))
const dist = join(temp, 'dist'), overlays = join(temp,'overlays')
await mkdir(dist); await mkdir(overlays)
await writeFile(join(dist,'index.html'), '<!doctype html><html><head><title>Current workspace fixture</title></head><body><h1>Current workspace fixture</h1><p>Isolated browser-entry proof.</p></body></html>')
const config = join(temp,'cordis.yml')
await writeFile(config, JSON.stringify([
 { name:'@deepseek-ai/dsh-credentials-local', config:{path:join(temp,'credentials.yml'),watch:false} },
 { name:'@deepseek-ai/dsh-host-webserver', config:{host:'127.0.0.1',port:0} },
 { name:'@deepseek-ai/dsh-client-connection' },
 { name:'@deepseek-ai/dsh-host-frontend-static',config:{distIndex:join(dist,'index.html')} }
]))
process.env.DSH_TRUST_MESH_CIDRS='127.0.0.0/8'
const context = new Context()
let browser
try {
 context.baseUrl=pathToFileURL(temp).href+'/'
 await context.plugin(Loader)
 context.loader.builtins.include=Include
 const modules=new Map([
 ['@deepseek-ai/dsh-credentials-local',LocalCredentials],
 ['@deepseek-ai/dsh-host-webserver',HttpServer],
 ['@deepseek-ai/dsh-client-connection',Connection],
 ['@deepseek-ai/dsh-host-frontend-static',FrontendStatic]
 ])
 context.loader.internal={version:'v2', async import(name) { if(!modules.has(name))throw Error('Unexpected fixture import');return modules.get(name) }}
 await context.loader.create({name:'cordis:include',config:{path:pathToFileURL(config).href}})
 await context.loader.await()
 const graph={rev:'fixture',entries:[{id:'@fixture/ui',url:'plugins/fixture.js',rev:'base'}],batches:[]}
 context.on('webserver/index-inject', (_rows,_peer,url)=>selectOverlayBoot(graph,url,overlays))
 const origin='http://127.0.0.1:'+context.webServer.port
 browser=await firefox.launch({headless:true,executablePath:'/home/sf/.cache/ms-playwright/firefox-1532/firefox/firefox'})
 const session=await browser.newContext()
 const page=await session.newPage()
 const responses=[], errors=[]
 page.on('response',r=>{if(r.request().isNavigationRequest()) responses.push(r.status())})
 page.on('pageerror',e=>errors.push(e.name))
 const query='?exo_overlay=fable-panes&panel=actors&chat=session-fixture&tag=one&tag=two'
 await page.goto('data:text/html,'+encodeURIComponent('<a href="'+origin+'/'+query.replaceAll('&','&amp;')+'">Open missing view</a>'))
 await page.getByRole('link',{name:'Open missing view'}).click()
 await page.getByTestId('overlay-entry-unavailable').waitFor()
 assert.equal(responses.at(-1),404)
 assert.equal(await page.locator('script').count(),0)
 assert.equal(new URL(page.url()).searchParams.get('exo_overlay'),'fable-panes')
 assert.deepEqual(await readdir(overlays),[])
 const recovery=page.getByRole('link',{name:'Open current workspace',exact:true})
 const href=await recovery.getAttribute('href')
 assert.equal(href,'./?panel=actors&chat=session-fixture&tag=one&tag=two')
 await page.screenshot({path:join(proofDir,'missing-overlay.png'),fullPage:true})
 record.checks.push({name:'cross-site-missing-overlay',ok:true,status:404,explicitRecovery:true,overlayStateCreated:false})
 await save()
 await recovery.click()
 await page.getByRole('heading',{name:'Current workspace fixture',exact:true}).waitFor()
 const final=new URL(page.url())
 assert.equal(final.origin,origin)
 assert.equal(final.search,'?panel=actors&chat=session-fixture&tag=one&tag=two')
 assert.deepEqual(errors,[])
 record.checks.push({name:'explicit-current-workspace-recovery',ok:true,status:responses.at(-1),panelAndChatPreserved:true,duplicateQueryPreserved:true})
 await save()
 const head=await session.request.head(origin+'/'+query)
 assert.equal(head.status(),404);assert.equal((await head.body()).length,0)
 record.checks.push({name:'recovery-head-response',ok:true,status:404,bodyBytes:0})
 record.complete=true;await save()
 process.stdout.write(JSON.stringify({ok:true,checks:record.checks.length,receipt:join(proofDir,'receipt.json')})+'\n')
} catch(error) {
 record.checks.push({name:'failure',ok:false,type:error?.name,message:String(error?.message||error).replace(/https?:\/\/[^\s]+/gu,'[fixture-url]')})
 await save();process.exitCode=1
} finally {
 await browser?.close()
 await context.fiber.dispose()
 await rm(temp,{recursive:true,force:true})
}
