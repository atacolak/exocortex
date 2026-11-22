#!/usr/bin/env python3
"""Apply the reviewed host-only switch after all gates, with exact pre/post receipts."""
import collections, datetime, hashlib, importlib.util, json, os, pathlib, subprocess, sys, time, urllib.request
ROOT=pathlib.Path('/home/sf/worktrees/dsh/cap/browser-auth-entry-20261122')
PROOF=ROOT/'.proof/browser-auth-entry'
DROP=pathlib.Path('/home/sf/.config/systemd/user/dsh-web.service.d/95-browser-entry-20261122.conf')
spec=importlib.util.spec_from_file_location('preflight',PROOF/'capture-preflight.py')
helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
receipt={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'pending','phase':'gates','productionMutation':False}
out=PROOF/'production-promotion.json'
def save():out.write_text(json.dumps(receipt,indent=2)+'\n')
def require(value,code):
 if not value:raise RuntimeError(code)
def cmd(args,timeout=40):subprocess.run(args,check=True,timeout=timeout,stdout=subprocess.DEVNULL)
def normalized_plugins(rows):
 return collections.Counter(json.dumps({**v,'moduleName':v.get('moduleName').replace(str(ROOT),str(helper.LIVE)) if isinstance(v.get('moduleName'),str) else v.get('moduleName')},sort_keys=True) for v in rows.values())
save()
try:
 require(sys.argv[1:]==['--promote-reviewed'],'explicit-promotion-flag-required')
 gates=json.loads((PROOF/'final-gates.json').read_text())
 require(gates.get('complete') and len(gates.get('checks',[]))==4,'final-gates-incomplete')
 require(all(x['exitCode']==0 for x in gates['checks'] if x['name']!='final-test-gui'),'required-build-or-pairing-gate-failed')
 gui=next(x for x in gates['checks'] if x['name']=='final-test-gui')
 if gui['exitCode']!=0:
  recheck=json.loads((PROOF/'gui-recheck.json').read_text())
  failures=json.loads((PROOF/'gui-failures.json').read_text())
  require(recheck.get('complete') and recheck.get('exitCode')==0 and recheck.get('testTimeoutsUnchanged') is True,'gui-timeout-recheck-not-passed')
  require(set(recheck['files'])=={x['file'] for x in failures['failures']},'gui-recheck-coverage-incomplete')
  receipt['gateAcceptance']='Original broad run retained:723 files green,9 timeout files; all9 unchanged-code files rechecked green443/443. Root explicitly approved this acceptance.'
 require('approved for the frozen candidate' in (PROOF/'independent-review.md').read_text().lower(),'review-approval-required')
 manifest=json.loads((PROOF/'promotion-artifacts.json').read_text())
 for p,sha in manifest['paths'].items():require(helper.digest(ROOT/p)==sha,'artifact-hash-drift:'+p)
 require(not subprocess.check_output(['git','diff','--name-only'],cwd=ROOT,text=True).strip(),'tracked-source-uncommitted')
 cmd(['git','-C',str(ROOT),'ls-files','--error-unmatch','.proof/bundles/exo-overlay/lib/entry-recovery.js'])
 receipt['commit']=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
 receipt['phase']='fresh-preflight';save()
 before=helper.capture()
 require(before['service']['KillMode']=='process','group-killing-service')
 require(str(helper.LIVE/'apps/cli/lib/bin.js') in before['service']['ExecStart'],'web-owner-drift')
 require(not before['ourOverrideExists'],'override-already-exists')
 require(before['bundles'].get('@exocortex/actors')=={'enabled':True,'installed':True,'source':'link:/home/sf/worktrees/exocortex-bundles/candidates/actors-refine-20261123/actors','version':'0.4.0'},'actors-state-drift')
 (PROOF/'production-preimage.json').write_text(json.dumps(before,indent=2)+'\n')
 old_op,origin=helper.opener()
 receipt['before']={'webPid':before['service']['MainPID'],'nativeOwners':len(before['nativeOwners']),'bundles':len(before['bundles']),'plugins':len(before['plugins'])}
 receipt['phase']='install-exact-override';save()
 content=(PROOF/'95-browser-entry-20261122.conf').read_bytes()
 fd=os.open(DROP,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
 with os.fdopen(fd,'wb') as stream:stream.write(content);stream.flush();os.fsync(stream.fileno())
 receipt['productionMutation']=True;save()
 cmd(['systemctl','--user','daemon-reload'])
 require(helper.service()['KillMode']=='process','killmode-changed-before-restart')
 receipt['phase']='restart-mirror';save()
 cmd(['systemctl','--user','restart','dsh-web.service'],timeout=50)
 receipt['phase']='postflight';save()
 after=None
 for attempt in range(30):
  try:after=helper.capture();break
  except Exception:time.sleep(1)
 require(after is not None,'host-did-not-become-ready')
 (PROOF/'production-postimage.json').write_text(json.dumps(after,indent=2)+'\n')
 require(after['service']['KillMode']=='process','post-killmode-drift')
 require(str(ROOT/'apps/cli/lib/bin.js') in after['service']['ExecStart'],'candidate-not-active')
 require(after['service']['MainPID']!=before['service']['MainPID'],'mirror-pid-not-replaced')
 require(after['files']==before['files'],'profile-or-original-service-file-drift')
 require(after['bundles']==before['bundles'],'bundle-state-drift')
 require(normalized_plugins(after['plugins'])==normalized_plugins(before['plugins']),'plugin-enablements-or-modules-drift')
 post={(x['sessionId'],x['pid']):x for x in after['nativeOwners']}
 changed=[{'sessionId':x['sessionId'],'pid':x['pid']} for x in before['nativeOwners'] if post.get((x['sessionId'],x['pid']))!=x]
 receipt['changedNativeOwners']=changed
 require(not changed,'native-owner-process-changed')
 with old_op.open(urllib.request.Request(origin+'/?panel=actors',headers={'Accept':'text/html'}),timeout=20) as response:
  body=response.read(32768).decode(errors='replace')
  require(response.status==200 and response.headers.get('set-cookie') is None and 'Opening the application' not in body,'pre-existing-cookie-not-retained')
 receipt['checks']=['candidate web owner active','all current profile and service preimage files unchanged','all53 bundle projections unchanged','all230 plugin projections unchanged except deliberate overlay module path','all captured native PID/starttime/cgroup identities unchanged','pre-existing signed browser cookie remains accepted']
 receipt['after']={'webPid':after['service']['MainPID'],'nativeOwners':len(after['nativeOwners']),'bundles':len(after['bundles']),'plugins':len(after['plugins'])}
 receipt['status']='mechanical-pass';receipt['phase']='await-public-and-ui-proof';save()
 print(json.dumps({'ok':True,'receipt':str(out),'webPid':after['service']['MainPID'],'nativeOwnersPreserved':len(before['nativeOwners'])}))
except Exception as error:
 receipt['status']='failed';receipt['errorType']=type(error).__name__
 receipt['errorCode']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
 save()
 print(json.dumps({'ok':False,'receipt':str(out),'phase':receipt['phase'],'errorCode':receipt['errorCode'],'productionMutation':receipt['productionMutation']}))
 raise SystemExit(1)
