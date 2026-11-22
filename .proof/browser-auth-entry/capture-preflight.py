#!/usr/bin/env python3
"""Read-only, sanitized current host/profile/native-owner receipt. No actor writes."""
import datetime, hashlib, http.cookiejar, json, os, pathlib, subprocess, sys, urllib.parse, urllib.request, uuid
ROOT=pathlib.Path('/home/sf/worktrees/dsh/cap/browser-auth-entry-20261122')
LIVE=pathlib.Path('/home/sf/worktrees/dsh/cap/normal-startup-20261119')
PROOF=ROOT/'.proof/browser-auth-entry'
def digest(p):
 p=pathlib.Path(p)
 return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
def service():
 out=subprocess.check_output(['systemctl','--user','show','dsh-web.service','-p','MainPID','-p','KillMode','-p','ControlGroup','-p','ExecStart','-p','ExecStop','-p','DropInPaths'],text=True)
 return dict(line.split('=',1) for line in out.splitlines() if '=' in line)
def processes():
 records=[]
 for p in sorted(pathlib.Path('/home/sf/.omp/run').glob('*.json')):
  try:
   row=json.loads(p.read_text())
   pid=row.get('pid')
   if not isinstance(pid,int) or pid<=0: continue
   proc=pathlib.Path('/proc')/str(pid)
   stat=proc.joinpath('stat').read_text().rsplit(') ',1)[1].split()
   if stat[0]=='Z': continue
   records.append({'sessionId':row.get('sessionId'),'pid':pid,'startTimeTicks':stat[19],'cgroup':proc.joinpath('cgroup').read_text().strip(),'comm':proc.joinpath('comm').read_text().strip()})
  except (FileNotFoundError,ProcessLookupError,PermissionError,ValueError,IndexError): pass
 return records
def opener():
 handle=pathlib.Path('/home/sf/.local/state/dsh-web-url.txt').read_text().strip()
 u=urllib.parse.urlsplit(handle)
 assert u.scheme=='http' and u.hostname=='10.77.67.147' and u.port==3080 and u.path=='/' and not u.username and not u.password
 origin=urllib.parse.urlunsplit((u.scheme,u.netloc,'','',''))
 jar=http.cookiejar.CookieJar()
 op=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(jar))
 with op.open(urllib.request.Request(handle,headers={'Accept':'text/html'}),timeout=20) as response: response.read(256)
 return op,origin
def manager(op,origin,method):
 rpcId=str(uuid.uuid4())
 body=json.dumps({'type':'client-request','rpcId':rpcId,'method':'pluginManager/'+method,'payload':{'args':{}}}).encode()
 req=urllib.request.Request(origin+'/api/pluginManager/'+method,data=body,headers={'Origin':origin,'Content-Type':'application/json'})
 with op.open(req,timeout=30) as response: result=json.load(response)
 assert result.get('rpcId')==rpcId and result.get('result',{}).get('ok') is True
 return result['result']['value']
def capture():
 svc=service()
 assert svc['KillMode']=='process','Host restart cannot be used with a group-killing KillMode.'
 op,origin=opener()
 bundles=manager(op,origin,'listBundles')
 plugins=manager(op,origin,'listPlugins')
 paths=['/home/sf/.dsh/profiles/web/package.json','/home/sf/.dsh/profiles/web/cordis.patch.yml','/home/sf/.dsh/cordis.patch.yml',str(LIVE/'.proof/normal.patch.yml'),'/home/sf/.config/systemd/user/dsh-web.service','/home/sf/.config/systemd/user/dsh-web.service.d/90-normal-startup-20261119.conf']
 return {'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'service':svc,
 'files':{p:digest(p) for p in paths},
 'bundles':{str(r['name']):{k:r.get(k) for k in ['enabled','installed','source','version']} for r in bundles},
 'plugins':{str(r['entryId']):{k:r.get(k) for k in ['enabled','moduleName']} for r in plugins},
 'nativeOwners':processes(),
 'ourOverrideExists':pathlib.Path('/home/sf/.config/systemd/user/dsh-web.service.d/95-browser-entry-20261122.conf').exists()}
if __name__=='__main__':
 output=pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else PROOF/'preflight-current.json'
 try:
  data=capture();output.write_text(json.dumps(data,indent=2)+'\n')
  print(json.dumps({'ok':True,'receipt':str(output),'webPid':data['service']['MainPID'],'killMode':data['service']['KillMode'],'bundles':len(data['bundles']),'plugins':len(data['plugins']),'nativeOwners':len(data['nativeOwners']),'ourOverrideExists':data['ourOverrideExists']}))
 except Exception as error:
  print(json.dumps({'ok':False,'type':type(error).__name__}));raise SystemExit(1)
