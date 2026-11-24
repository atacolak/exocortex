/**
 * Isolated artifact acceptance: real app boot/Loader, native Agent/Session,
 * persisted journal and an actual Unix-socket child. Only OMP inference is a
 * deterministic external fixture. No production paths or owners are used.
 *
 * node tests/live-tools.loader.mjs /absolute/staged/lib/index.js [receipt.json]
 */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp, mkdir, readFile, writeFile, chmod, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {pathToFileURL, fileURLToPath} from 'node:url'
import {randomUUID, createHash} from 'node:crypto'
import {boot} from '../../../boot/app-boot/lib/index.js'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, {createUserMessage} from '@deepseek-ai/dsh-llm'
import SessionStore, {SessionId, KNOWN_SESSION_EVENT_TYPES} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import {assertReleasedV4Relationships} from '@deepseek-ai/dsh-session-format-v3-to-v4'

const artifact=resolve(process.argv[2]||'')
if(!process.argv[2])throw new Error('Pass the isolated Host artifact path')
const root=await mkdtemp(join(tmpdir(),'omp-live-loader-'))
const run=join(root,'run'),markers=join(root,'markers'),journals=join(root,'journals')
await Promise.all([mkdir(run),mkdir(markers),mkdir(journals)])
const ompId=randomUUID(),sessionId=SessionId('session-'+randomUUID())
const transcript=join(journals,ompId+'.jsonl'),gate=join(root,'complete-tool')
const fixture=fileURLToPath(new URL('./fixtures/fake-omp.mjs',import.meta.url))
const owner=spawn(process.execPath,[fixture],{
 cwd:root,stdio:['pipe','pipe','pipe'],
 env:{...process.env,OMP_TEST_PUBLICATION_DIR:run,OMP_TEST_TRANSCRIPT:transcript,
 OMP_TEST_MARKERS:markers,OMP_TEST_SESSION_ID:ompId,OMP_TEST_TOOL_GATE:gate},
})
let ownerStderr=''
owner.stderr.setEncoding('utf8');owner.stderr.on('data',chunk=>{ownerStderr+=chunk})
owner.stdout.resume()
let ctx,handle,api
const until=async(check,label,timeout=5000)=>{
 const end=Date.now()+timeout
 while(Date.now()<end){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,10))}
 console.error(JSON.stringify({failure:label,agentStatus:handle?.agent.status,events:handle?.agent.session.snapshotEvents(),commands:await readCommands().catch(()=>[])}))
 throw new Error('Timed out: '+label+'; fixture stderr='+ownerStderr)
}
const exists=path=>stat(path).then(()=>true,()=>false)
const readCommands=async()=>JSON.parse('['+(await readFile(join(markers,'commands.jsonl'),'utf8')).trim().split('\n').join(',')+']')
try {
 await until(()=>exists(join(run,ompId+'.json')),'isolated socket publication')
 const bindings=join(root,'bindings.json')
 await writeFile(bindings,JSON.stringify({version:1,sessions:{[sessionId]:{ompSessionId:ompId,path:transcript,cwd:root,updatedAt:new Date().toISOString()}},forks:{}}))
 const catalog=join(root,'catalog.mjs')
 await writeFile(catalog,'#!'+process.execPath+'\nprocess.stdout.write(JSON.stringify(process.argv[2]==="models"?{models:[]}:{skills:[]}));\n')
 await chmod(catalog,0o755)
 const config=join(root,'cordis.yml')
 const builtin=[
  ['llm','proofLlm'],['sessions','proofSessions'],['projections','proofProjections'],
  ['agents','proofAgents'],['persistence','proofPersistence'],['commands','proofCommands'],
  ['tools','proofTools'],['subprocess','proofSubprocess'],
 ].map(([id,name])=>({id,name:'cordis:'+name,...id==='persistence'?{config:{root:join(root,'dsh-log'),compression:'none'}}:{}}))
 await writeFile(config,JSON.stringify([...builtin,{
  id:'omp-rpc',name:pathToFileURL(artifact).href,
  config:{executable:catalog,home:root,cwd:root,bindingsFile:bindings,
   ompSessionsRoot:journals,sessionDir:journals,watchRunDir:run,watchIntervalMs:60000,
   hcomExtension:'',hostTools:[],detachedDaemon:false},
 }]))
 ctx=await boot('test',config,[],host=>{
  Object.assign(host.loader.builtins,{
   proofLlm:LlmRuntime,proofSessions:SessionStore,proofProjections:SessionProjectionRegistry,
   proofAgents:AgentRegistry,proofPersistence:JsonlSessionPersistence,
   proofCommands:CommandRuntime,
   proofTools:{name:'empty external host-tool catalog',apply(scope){scope.provide('tools',{definitions:()=>[]})}},
   proofSubprocess:{name:'fixture subprocess boundary',apply(scope){
    scope.provide('subprocess',{
     resolveExecutable:async command=>command,
     spawn:()=>{throw new Error('A published native socket must not launch another owner')},
    })
   }},
  })
 })
 await ctx.loader.await()
 const entry=[...ctx.loader.entries()].find(row=>row.options.id==='omp-rpc')
 assert.ok(entry?.fiber,'actual OMP Loader entry must be active')
 api=entry.moduleNamespace
 const readOwner=async()=>{
  const connection=await api.connectOmpSocket(join(run,ompId+'.sock'))
  try {return await connection.client.request({type:'get_state'})}
  finally{connection.close()}
 }
 const before=await readOwner()
 assert.equal(before.sessionId,ompId)
 handle=await ctx.agents.create({sessionId,meta:{cwd:root},agentOptions:{provider:'fake',model:'fake'}})
 const agent=handle.agent
 await agent.attach()
 agent.followup(createUserMessage({content:[{type:'text',text:'run the gated native tool'}],source:{kind:'user'}}))
 await until(()=>exists(join(markers,'tool-started')),'real child tool start')
 const held=await until(()=>{
  const events=agent.session.snapshotEvents()
  return events.some(event=>event.type==='tool/call')?events:undefined
 },'declared native call before releasing tool',1500)
 const call=held.find(event=>event.type==='tool/call')
 assert.equal(call.data.callId,'call-slow')
 assert.equal(JSON.parse(call.data.arguments).i,'run the slow tool')
 assert.equal(held.filter(event=>event.type==='tool/result').length,0)
 assert.equal(await exists(join(markers,'turn-finished')),false)
 const heldAt=Date.now()
 // Exercise the real Loader entry disposal order, not AgentHandle.dispose().
 await entry.update({disabled:true})
 await ctx.loader.await()
 await until(()=>agent.status==='idle','local mirror settled after Loader unload')
 const closed=agent.session.snapshotEvents()
 const results=closed.filter(event=>event.type==='tool/result')
 assert.equal(results.length,1)
 assert.equal(results[0].data.error?.code,'TOOL_OUTCOME_UNKNOWN')
 assert.notEqual(closed.findLast(event=>event.type==='turn/end')?.data.reason.kind,'completed','detached mirror must not claim native completion')
 assertReleasedV4Relationships({header:agent.session.header,inheritedEventCount:0,events:closed},KNOWN_SESSION_EVENT_TYPES)
 await ctx.sessionPersistence.flush()
 const stored=await ctx.sessionPersistence.open(sessionId,'read')
 try {assertReleasedV4Relationships(await stored.read(),KNOWN_SESSION_EVENT_TYPES)}
 finally {await stored.close()}
 const after=await readOwner()
 assert.equal(after.pid,before.pid)
 assert.equal(after.bootId,before.bootId)
 assert.equal(after.sessionId,before.sessionId)
 assert.equal(after.sessionFile,before.sessionFile)
 assert.equal(after.isStreaming,true)
 assert.equal(owner.exitCode,null)
 assert.equal((await readCommands()).filter(frame=>frame.type==='abort'||frame.type==='shutdown'||frame.type==='exit_session').length,0)
 await writeFile(gate,'complete')
 await until(()=>exists(join(markers,'turn-finished')),'detached owner completed its own tool')
 const nativeJournal=(await readFile(transcript,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
 assert.equal(nativeJournal.filter(row=>row.message?.role==='toolResult').length,1)
 const receipt={artifact,artifactSha256:createHash('sha256').update(await readFile(artifact)).digest('hex'),
  ownerPid:before.pid,ownerBootId:before.bootId,sessionId,nativeSessionId:ompId,
  intentBeforeResult:true,heldAt,loaderUnloadWithoutAbort:true,ownerIdentityPreserved:true,
  localToolOutcome:'TOOL_OUTCOME_UNKNOWN',nativeToolResultCount:1,
  localCallCount:closed.filter(event=>event.type==='tool/call').length,localResultCount:results.length,
  localTurnReason:closed.findLast(event=>event.type==='turn/end')?.data.reason.kind,
  nativePromptCount:(await readCommands()).filter(frame=>frame.type==='prompt').length,
  replayValid:true}
 if(process.argv[3])await writeFile(resolve(process.argv[3]),JSON.stringify(receipt,null,2)+'\n')
 console.log(JSON.stringify(receipt,null,2))
} finally {
 await handle?.dispose().catch(()=>{})
 await ctx?.fiber.dispose().catch(()=>{})
 owner.stdin.end()
 if(owner.exitCode===null)await new Promise(resolveDone=>{
  const timer=setTimeout(()=>{owner.kill('SIGTERM');resolveDone()},1000)
  owner.once('exit',()=>{clearTimeout(timer);resolveDone()})
 })
 await rm(root,{recursive:true,force:true})
}
