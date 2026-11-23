import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readlinkSync,realpathSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {preferredWorkspaceRedirect,prepareWorkbenchLink,resolveConfig} from '../bundles/exo-overlay/index.js'
import {selectOverlayBoot} from '../bundles/exo-overlay/lib/boot.js'

function response() {return {status:null,headers:null,ended:false,writeHead(status,headers){this.status=status;this.headers=headers},end(){this.ended=true}}}
function preferred(url,cookie='',method='GET') {const res=response();const taken=preferredWorkspaceRedirect({url,method,headers:{cookie}},res);return {taken,res}}
test('main with no preference renders normally and does not redirect',()=>assert.equal(preferred('/?panel=actors&chat=session-mate').taken,false))
test('saved workbench preference redirects before the normal boot',()=>{const {taken,res}=preferred('/?panel=actors&chat=session-mate#top','x=y; exo_last_view=workbench; ab=1');assert.equal(taken,true);assert.equal(res.status,302);assert.equal(res.headers.Location,'/?panel=actors&chat=session-mate&exo_overlay=workbench#top')})
test('legacy fable-panes deep links resolve to named workbench without dropping query state',()=>{const {res}=preferred('/?exo_overlay=fable-panes&panel=actors&chat=session-x','');assert.equal(res.headers.Location,'/?exo_overlay=workbench&panel=actors&chat=session-x')})
test('explicit workbench does not redirect twice, and explicit main removes obsolete selector',()=>{assert.equal(preferred('/?exo_overlay=workbench','exo_last_view=workbench').taken,false);const {res}=preferred('/?exo_overlay=main&panel=actors','exo_last_view=workbench');assert.equal(res.headers.Location,'/?panel=actors');assert.match(res.headers['Set-Cookie'],/exo_last_view=main/)})
test('only document GET/HEAD is eligible; previews and unrelated cookies are untouched',()=>{for(const [url,cookie,method] of [['/api/exocortex/overlay/runs','exo_last_view=workbench','GET'],['/','exo_last_view=workbench','POST'],['/?exo_overlay=preview','exo_last_view=workbench','GET'],['/?exo_overlay=foo&exo_overlay=bar','exo_last_view=workbench','GET'],['/','exo_last_view=workbench-bad','GET']])assert.equal(preferred(url,cookie,method).taken,false)})
test('workbench is backed by saved disk and reconnects after transient /tmp is lost',()=>{const root=mkdtempSync(join(tmpdir(),'exo-view-'));const persistent=mkdtempSync(join(tmpdir(),'exo-saved-'));try { const pkg=join(persistent,'@exocortex','exo-workbench');mkdirSync(pkg,{recursive:true});writeFileSync(join(pkg,'client.js'),'window.test=1'); prepareWorkbenchLink(root,persistent);assert.equal(readFileSync(join(root,'workbench','@exocortex','exo-workbench','client.js'),'utf8'),'window.test=1');rmSync(join(root,'workbench'),{recursive:true});prepareWorkbenchLink(root,persistent);assert.equal(readFileSync(join(root,'workbench','@exocortex','exo-workbench','client.js'),'utf8'),'window.test=1');assert.doesNotThrow(()=>prepareWorkbenchLink(root,persistent)); } finally {rmSync(root,{recursive:true,force:true});rmSync(persistent,{recursive:true,force:true})}})
test('main graph loads original existing selector, without touching any other plugin',()=>{
 const root=mkdtempSync(join(tmpdir(),'exo-main-'));const saved=mkdtempSync(join(tmpdir(),'exo-saved-'))
 try {
  for(const pkg of ['exo-workbench','exo-overlay','session-chrome']) { const dir=join(saved,'@exocortex',pkg);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'client.js'),`// ${pkg}`);writeFileSync(join(dir,'package.json'),JSON.stringify({name:'@exocortex/'+pkg})) }
  prepareWorkbenchLink(root,saved)
  const graph={rev:'main-rev',entries:[{id:'bootstrap',url:'/boot.js',rev:'b'},{id:'@exocortex/exo-workbench',url:'/workbench.js',rev:'w'},{id:'@exocortex/exo-overlay',url:'/old-overlay.js',rev:'o'},{id:'@exocortex/session-chrome',url:'/old-session.js',rev:'s'}],batches:[{phase:'bootstrap',url:'/boot.js',rev:'b',entries:['bootstrap']},{phase:'application',url:'/apps.js',rev:'1',entries:['@exocortex/exo-workbench','@exocortex/exo-overlay','@exocortex/session-chrome']}]}
  const main=selectOverlayBoot(graph,'https://example.test/?panel=actors',root,true)
  assert.equal(main.entries.find(x=>x.id==='@exocortex/exo-workbench').url,'/workbench.js')
  assert.equal(main.entries.find(x=>x.id==='@exocortex/exo-overlay').url.startsWith('/api/exocortex/overlay/workbench/'),true)
  assert.equal(main.entries.find(x=>x.id==='@exocortex/session-chrome').url.startsWith('/api/exocortex/overlay/workbench/'),true)

  assert.equal(main.batches.some(x=>x.url==='/old-overlay.js'),false)
  const workbench=selectOverlayBoot(graph,'https://example.test/?exo_overlay=workbench',root,true)
  assert.equal(workbench.entries.find(x=>x.id==='@exocortex/exo-workbench').url.startsWith('/api/exocortex/overlay/workbench/'),true)
 } finally {rmSync(root,{recursive:true,force:true});rmSync(saved,{recursive:true,force:true})}
})
test('refuses an empty saved view rather than showing main as if selected',()=>{const root=mkdtempSync(join(tmpdir(),'exo-view-'));const persistent=mkdtempSync(join(tmpdir(),'exo-saved-'));try{assert.throws(()=>prepareWorkbenchLink(root,persistent),/missing its built client/)}finally{rmSync(root,{recursive:true,force:true});rmSync(persistent,{recursive:true,force:true})}})
test('normal and workbench select different initial graphs; not main then a client swap',()=>{const root=mkdtempSync(join(tmpdir(),'exo-view-'));const saved=mkdtempSync(join(tmpdir(),'exo-saved-'));try{const pkg=join(saved,'@exocortex','exo-workbench');mkdirSync(pkg,{recursive:true});writeFileSync(join(pkg,'client.js'),'window.__WB__=true');writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'@exocortex/exo-workbench'}));prepareWorkbenchLink(root,saved);const graph={rev:'main-rev',entries:[{id:'bootstrap',url:'/boot.js',rev:'1'},{id:'@exocortex/exo-workbench',url:'/canonical.js',rev:'2'}],batches:[{phase:'bootstrap',url:'/boot.js',rev:'1',entries:['bootstrap']},{phase:'application',url:'/canonical.js',rev:'2',entries:['@exocortex/exo-workbench']} ]};assert.equal(selectOverlayBoot(graph,'https://example.test/?panel=actors',root),graph);const selected=selectOverlayBoot(graph,'https://example.test/?exo_overlay=workbench&panel=actors',root);assert.notEqual(selected.rev,graph.rev);assert.equal(selected.entries[1].url.startsWith('/api/exocortex/overlay/workbench/'),true);assert.equal(selected.batches.some(x=>x.url==='/canonical.js'),false);assert.equal(selected.batches.some(x=>x.url.includes('/overlay/workbench/')),true)}finally{rmSync(root,{recursive:true,force:true});rmSync(saved,{recursive:true,force:true})}})
