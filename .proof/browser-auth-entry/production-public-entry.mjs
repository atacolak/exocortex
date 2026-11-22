/** Real public entry proof after the reviewed mirror switch; no messages or native mutations. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
const root=resolve(new URL('../..',import.meta.url).pathname)
assert.equal(process.argv[2],'--promoted')
const switchReceipt=JSON.parse(await readFile(join(root,'.proof/browser-auth-entry/production-promotion.json'),'utf8'))
assert.equal(switchReceipt.status,'mechanical-pass')
const requireWeb=createRequire(join(root,'apps/web/package.json'))
const {firefox}=requireWeb('playwright')
const origin='https://exocortex.net.colak.sh',anchor='session-40b82257-e809-4912-9350-670a730dc956'
const out=join(root,'.proof/browser-auth-entry/production-public-entry')
await mkdir(out,{recursive:true})
const receipt={status:'running',checks:[],blocked:[],nativeInputRequests:0,sessionWorkspaceMutations:0,pluginMutations:0,nativeAttachRequests:0,actorMutations:0,pageErrors:[],documents:[]}
const save=()=>writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
const inputMethods=new Set(['session/prompt','session/query','session/updateQueue','session/cancel'])
const safeSessionMethods=new Set(['list','search','modelCatalog','canOpenWorkspacePath','workspacePathApplications','attachment','page','events','observeEvent','observeProjections','state','observeState','wait','follow','projections','control'])
const safeWorkspaceMethods=new Set(['list','observe','watch','snapshot','follow'])
const safePluginMethods=new Set(['listBundles','listPlugins','listOfficial','listVersions','inspect','graph','getGraph'])
function guardedMethod(method){
 if(typeof method!=='string')return null
 const value=method.replace(/^\/?api\//,'')
 if(inputMethods.has(value))return 'native-input'
 if(value.startsWith('session/')&&!safeSessionMethods.has(value.slice(8)))return 'session-workspace'
 if(value.startsWith('workspace/')&&!safeWorkspaceMethods.has(value.slice(10)))return 'session-workspace'
 if(value.startsWith('pluginManager/')&&!safePluginMethods.has(value.slice(14)))return 'plugin-mutation'
 if(/^(omp|actor|actors)\/.*(send|prompt|message|model|thinking|restart|shutdown|wake|start|stop|refresh|create|rename|set|update)/i.test(value))return 'native-input'
 return null
}
function forbid(reason,method){
 if(reason==='native-input')receipt.nativeInputRequests++
 else if(reason==='session-workspace')receipt.sessionWorkspaceMutations++
 else if(reason==='plugin-mutation')receipt.pluginMutations++
 receipt.blocked.push({reason,method:String(method||'').slice(0,120)})
}
const browser=await firefox.launch({headless:true,executablePath:'/home/sf/.cache/ms-playwright/firefox-1532/firefox/firefox'})
async function isolated(){
 const context=await browser.newContext({viewport:{width:1920,height:1080},locale:'en-US',colorScheme:'dark',serviceWorkers:'block'})
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());let payload;try{payload=request.postDataJSON()}catch{}
  for(const method of [payload?.endpoint,payload?.method,url.pathname.replace(/^\/api\//,'')]){
   const reason=guardedMethod(method);if(reason){forbid(reason,method);return route.abort('blockedbyclient')}
  }
  await route.fallback()
 })
 await context.routeWebSocket('**/*',socket=>{const server=socket.connectToServer();socket.onMessage(message=>{
  let frame;try{frame=JSON.parse(String(message))}catch{}
  const method=frame?.endpoint||frame?.method,reason=guardedMethod(method)
  if(reason){forbid(reason,method);return}server.send(message)
 })})
 const reads=new Set(['inventory','detail','definition','catalog','models','model.roles','thinking','lifecycle.info'])
 await context.route('**/api/actors.*',async route=>{
  const endpoint=new URL(route.request().url()).pathname.replace('/api/actors.','')
  if(!reads.has(endpoint)){receipt.actorMutations++;receipt.blocked.push({reason:'actor-api-mutation',endpoint});return route.abort('blockedbyclient')}
  return route.continue()
 })
 await context.route('**/api/exocortex/omp/open',route=>{receipt.nativeAttachRequests++;receipt.blocked.push({reason:'native-attach'});return route.abort('blockedbyclient')})
 const page=await context.newPage();page.setDefaultTimeout(30000)
 page.on('pageerror',error=>receipt.pageErrors.push(error.name))
 page.on('response',response=>{if(response.request().isNavigationRequest()){const u=new URL(response.url());receipt.documents.push({origin:u.origin,path:u.pathname,status:response.status(),continuation:u.searchParams.has('__dsh_auth_continue'),overlay:u.searchParams.get('exo_overlay'),panel:u.searchParams.get('panel')})}})
 return {context,page}
}
function target(missing=false){
 const url=new URL(origin)
 url.searchParams.set('s',anchor);url.searchParams.set('chat',anchor);url.searchParams.set('panel','actors')
 if(missing)url.searchParams.set('exo_overlay','fable-panes')
 return url
}
async function crossSite(page,url){
 await page.goto('data:text/html,'+encodeURIComponent('<a href="'+url.href.replaceAll('&','&amp;')+'">Open workspace</a>'))
 await page.getByRole('link',{name:'Open workspace',exact:true}).click()
}
try{
 await save()
 let {context,page}=await isolated()
 await crossSite(page,target())
 await page.locator('[data-conversation-session="'+anchor+'"] [contenteditable="true"]').first().waitFor({state:'attached'})
 await page.getByRole('button',{name:'Actors',exact:true}).click()
 await page.getByTestId('actors-workspace').waitFor()
 const actual=new URL(page.url())
 assert.equal(actual.origin,origin);assert.equal(actual.searchParams.has('__dsh_auth_continue'),false)
 const cookies=await context.cookies()
 assert(cookies.some(x=>x.name.startsWith('dsh-auth-')&&x.sameSite==='Strict'&&x.httpOnly))
 receipt.checks.push({name:'fresh-public-cross-site-actors',ok:true,strictCookie:true,actualActorsSurface:true})
 await save();await context.close()
 ;({context,page}=await isolated())
 const start=receipt.documents.length
 await crossSite(page,target(true))
 await page.getByTestId('overlay-entry-unavailable').waitFor()
 assert.equal(receipt.documents.at(-1).status,404)
 assert.equal(await page.locator('script').count(),0)
 const recovery=page.getByRole('link',{name:'Open current workspace',exact:true})
 const href=await recovery.getAttribute('href'),clean=new URL(href,page.url())
 assert.equal(clean.origin,origin)
 assert.equal(clean.searchParams.get('panel'),'actors')
 assert.equal(clean.searchParams.get('chat'),anchor)
 assert.equal(clean.searchParams.has('exo_overlay'),false)
 await page.screenshot({path:join(out,'missing-overlay.png'),fullPage:true})
 receipt.checks.push({name:'fresh-public-missing-overlay',ok:true,status:404,explicitRecovery:true,automaticFallback:false})
 await save()
 await recovery.click()
 await page.locator('[data-conversation-session="'+anchor+'"] [contenteditable="true"]').first().waitFor({state:'attached'})
 await page.getByRole('button',{name:'Actors',exact:true}).click()
 await page.getByTestId('actors-workspace').waitFor()
 assert.equal(new URL(page.url()).searchParams.has('exo_overlay'),false)
 receipt.checks.push({name:'explicit-public-recovery-to-actors',ok:true,status:200,chatPreserved:true})
 assert(receipt.documents.slice(start).length<=4,'unexpected-document-chain')
 assert.deepEqual(receipt.blocked,[])
 receipt.status='passed';await save()
 process.stdout.write(JSON.stringify({ok:true,receipt:join(out,'receipt.json'),checks:receipt.checks.length})+'\n')
}catch(error){
 receipt.status='failed';receipt.error={name:error?.name,message:String(error?.message||error).replace(/https?:\/\/\S+/gu,'[url]').slice(0,700)}
 await save();process.exitCode=1
 process.stdout.write(JSON.stringify({ok:false,receipt:join(out,'receipt.json')})+'\n')
}finally{await browser.close()}
