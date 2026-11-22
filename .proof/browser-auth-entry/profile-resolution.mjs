/** Resolve current profile twice in a disposable copy; never boot plugins. */
import assert from 'node:assert/strict'
import { mkdtemp, copyFile, mkdir, symlink, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const candidate=resolve(new URL('../..',import.meta.url).pathname)
const original='/home/sf/worktrees/dsh/cap/normal-startup-20261119'
const actual='/home/sf/.dsh/profiles/web'
const {loadProfileDirectory,createRuntimeResolution,composeEntries,loadOverlayPatches}=await import(pathToFileURL(join(candidate,'packages/boot/app-boot/lib/index.js')).href)
const digest=async p=>createHash('sha256').update(await readFile(p)).digest('hex')
const profileBefore=await digest(join(actual,'package.json'))
const temp=await mkdtemp(join(tmpdir(),'exo-entry-resolution-'))
const clone=join(temp,'profiles/web')
await mkdir(clone,{recursive:true})
try{
 for(const file of ['package.json','cordis.patch.yml'])if(existsSync(join(actual,file)))await copyFile(join(actual,file),join(clone,file))
 await symlink(join(actual,'node_modules'),join(clone,'node_modules'))
 const runs=[]
 for(const [owner,patch] of [[original,'.proof/normal.patch.yml'],[candidate,'.proof/promotion.patch.yml']]){
  const installAnchor=join(owner,'apps/cli/package.json')
  const profile=loadProfileDirectory('entry-proof',clone,installAnchor)
  const resolution=await createRuntimeResolution({installAnchor,profile,home:'/home/sf/.dsh'})
  const layers=[...profile.layers.map(x=>x.patches),profile.patches]
  const home='/home/sf/.dsh/cordis.patch.yml'
  if(existsSync(home))layers.push(loadOverlayPatches('entry-proof',home))
  layers.push(loadOverlayPatches('entry-proof',join(owner,patch)))
  const rows=composeEntries(layers).map(x=>({id:x.id,name:x.name,disabled:x.disabled===true}))
  const packages=Object.fromEntries(resolution.entries.filter(x=>['@deepseek-ai/dsh-client-connection','@deepseek-ai/dsh-host-frontend-static','@deepseek-ai/dsh-omp-rpc'].includes(x.name)).map(x=>[x.name,{packageDir:x.packageDir,scope:x.scope}]))
  runs.push({owner,rows,packages,skipped:profile.skippedBundles.map(x=>x.packageName)})
 }
 const normalize=rows=>rows.map(x=>({...x,name:typeof x.name==='string'?x.name.replaceAll(candidate,'$OWNER').replaceAll(original,'$OWNER'):x.name}))
 assert.deepEqual(normalize(runs[1].rows),normalize(runs[0].rows))
 assert.deepEqual(runs[1].skipped,runs[0].skipped)
 assert(runs[1].packages['@deepseek-ai/dsh-client-connection'].packageDir.startsWith(candidate+'/'))
 assert(runs[1].packages['@deepseek-ai/dsh-host-frontend-static'].packageDir.startsWith(candidate+'/'))
 assert.equal(await digest(join(actual,'package.json')),profileBefore)
 const receipt={complete:true,observedAt:new Date().toISOString(),profileUnchanged:true,entries:runs[0].rows.length,entryEnablementIdentical:true,skippedBundles:runs[1].skipped,onlyIntentionalNamedModuleChange:'exo-overlay-normal-startup',resolution:runs.map(({owner,packages})=>({owner,packages}))}
 const output=join(candidate,'.proof/browser-auth-entry/profile-resolution.json')
 await writeFile(output,JSON.stringify(receipt,null,2)+'\n')
 process.stdout.write(JSON.stringify({ok:true,entries:receipt.entries,receipt:output})+'\n')
}finally{await rm(temp,{recursive:true,force:true})}
