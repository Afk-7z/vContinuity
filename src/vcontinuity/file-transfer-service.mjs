// Generic file transport owned by MCP v2. No voice synthesis, video editing or model turn.
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,writeFile,rename,unlink,stat,lstat,realpath,open} from 'node:fs/promises';
import {createHash,randomUUID,randomBytes} from 'node:crypto';

const MAX_INPUT = 512*1024*1024;
const TYPES={'.mp4':'video/mp4','.mov':'video/quicktime','.mkv':'video/x-matroska','.webm':'video/webm','.wav':'audio/wav','.mp3':'audio/mpeg','.ogg':'audio/ogg','.m4a':'audio/mp4','.flac':'audio/flac','.srt':'application/x-subrip','.pdf':'application/pdf'};
export function fail(code,host='') {const e=new Error(code); e.code=code; if(host)e.host=host; return e;}
export function authorizedFileUrl(value) {
  let u; try{u=new URL(value);}catch{throw fail('INVALID_NATIVE_FILE_URL');}
  if(u.protocol!=='https:'||u.username||u.password||u.hash||(u.port&&u.port!=='443'))throw fail('INVALID_NATIVE_FILE_URL');
  const h=u.hostname.toLowerCase();
  const storage=['oaiusercontent.com','files.openai.com','usercontent.openai.com'].some(d=>h===d||h.endsWith('.'+d));
  const estuary=h==='chatgpt.com'&&u.pathname==='/backend-api/estuary/content'&&u.searchParams.has('sig');
  // Exact OpenAI storage account returned by ChatGPT's native picker in the real integration test.
  // Do not authorize arbitrary Azure tenants or unsigned blob URLs.
  const regionalOpenAI=h==='oaisdmntprbrazilsouth.blob.core.windows.net'&&Boolean(u.searchParams.get('sig'));
  if(!storage&&!estuary&&!regionalOpenAI)throw fail('NATIVE_FILE_HOST_NOT_SUPPORTED',h);
  return u;
}
export async function sha256(file) {const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
function safeName(value,mime='') {
  let name=String(value||'attachment').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/^\.+|[ .]+$/g,'').slice(0,120);
  if(!path.extname(name)){const ext=Object.keys(TYPES).find(k=>TYPES[k]===mime);if(ext)name+=ext;}
  if(!name||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))throw fail('INVALID_FILENAME');
  return name;
}
export class FileTransferService {
  constructor({root=process.env.VCONTINUITY_FILE_ROOT||path.join(os.homedir(),'Documents','ChatGPT Media'),fetchImpl=fetch,tunnelStarter=null}={}) {
    this.root=path.resolve(root); this.inbox=path.join(this.root,'imports');this.exports=path.join(this.root,'exports');
    this.projects=path.join(this.root,'projects');this.stateDir=path.join(this.root,'.transfers');
    this.fetchImpl=fetchImpl;this.tunnelStarter=tunnelStarter;this.running=new Set();this.grants=new Map();this.lastUsed=Date.now();
  }
  async init(){await Promise.all([this.inbox,this.exports,this.projects,this.stateDir].map(p=>mkdir(p,{recursive:true})));}
  async workflow(){await this.init();return {ok:true,owner:'vContinuity',root:this.root,imports:this.inbox,exports:this.exports,projects:this.projects,
    max_input_bytes:MAX_INPUT,transfer_tool:'vcontinuity.transfer',picker_tool:'vcontinuity.file_picker',
    actions:['workflow','import','import_status','export'],
    rule:'Use native ChatGPT file objects for import. Never reinterpret a container /mnt/data path as a Windows path. Bytes are transferred without recompression.'};}
  statePath(id){if(!/^[a-f0-9]{32}$/.test(id))throw fail('INVALID_TRANSFER_ID');return path.join(this.stateDir,id+'.json');}
  async save(s){const target=this.statePath(s.import_id),tmp=target+'.tmp';await writeFile(tmp,JSON.stringify(s,null,2));
    // Windows may briefly hold the previous receipt open during a status read.
    for(let attempt=0;;attempt++){try{await rename(tmp,target);break;}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code)||attempt>=7)throw e;await new Promise(r=>setTimeout(r,15));}}
  }
  async status(id){await this.init();const s=JSON.parse(await readFile(this.statePath(id),'utf8'));
    if(['queued','importing'].includes(s.state)&&!this.running.has(id)){s.state='failed';s.error={code:'IMPORT_INTERRUPTED'};await this.save(s);}
    if(s.state==='complete'){try{const st=await stat(s.path);if(st.size!==s.bytes||st.mtimeMs!==s.mtime_ms)s.state='changed';}catch{s.state='missing';}}
    return s;
  }
  async startImport(args) {
    const before=this.startGate||Promise.resolve();let release;
    this.startGate=new Promise(r=>{release=r;});await before;
    try{return await this.startImportLocked(args);}finally{release();}
  }
  async startImportLocked({file,filename='',sha256_hex=''}) {
    await this.init();authorizedFileUrl(file.download_url);
    if(typeof file.file_id!=='string'||!file.file_id.trim())throw fail('NATIVE_FILE_ID_REQUIRED');
    if(sha256_hex&&!/^[a-f0-9]{64}$/i.test(sha256_hex))throw fail('INVALID_SHA256');
    const name=safeName(filename||file.file_name,file.mime_type);
    const id=createHash('sha256').update(file.file_id+'\0'+name+'\0'+sha256_hex.toLowerCase()).digest('hex').slice(0,32);
    try{const old=await this.status(id);if(['complete','queued','importing'].includes(old.state))return {...old,reused:true};if(['changed','missing'].includes(old.state))throw fail('IMPORTED_FILE_CHANGED');}catch(e){if(e.code!=='ENOENT')throw e;}
    if(this.running.size>=2)throw fail('IMPORT_BUSY');
    const s={ok:true,import_id:id,state:'queued',filename:name,file_id:file.file_id,received_bytes:0,total_bytes:null,created_at:Date.now()};
    await this.save(s);this.running.add(id);
    void this.download(s,file.download_url,sha256_hex).finally(()=>this.running.delete(id)).catch(()=>{});
    return s;
  }
  async download(s,url,expected) {
    const temporary=path.join(this.stateDir,s.import_id+'.part');let handle;
    try{
      s.state='importing';await this.save(s);let response;
      for(let redirects=0;redirects<4;redirects++){
        const native=authorizedFileUrl(url);
        response=await this.fetchImpl(native,{redirect:'manual',signal:AbortSignal.timeout(15*60*1000),headers:{'accept-encoding':'identity'}});
        if([301,302,303,307,308].includes(response.status)){
          const next=response.headers.get('location');await response.body?.cancel();
          if(!next||redirects===3)throw fail('NATIVE_REDIRECT_REFUSED');url=new URL(next,native).href;continue;
        }
        if(response.status!==200)throw fail('NATIVE_HTTP_'+response.status);
        break;
      }
      const declared=Number(response.headers.get('content-length'));
      if(declared>MAX_INPUT){await response.body?.cancel();throw fail('FILE_TOO_LARGE');}
      const encoding=response.headers.get('content-encoding');
      s.total_bytes=declared>0&&(!encoding||encoding==='identity')?declared:null;
      handle=await open(temporary,'w');const checksum=createHash('sha256');let savedAt=0;
      if(!response.body)throw fail('EMPTY_NATIVE_FILE');
      for await(const block of response.body){
        s.received_bytes+=block.length;if(s.received_bytes>MAX_INPUT)throw fail('FILE_TOO_LARGE');checksum.update(block);
        let offset=0;while(offset<block.length){const r=await handle.write(block,offset,block.length-offset);offset+=r.bytesWritten;}
        if(Date.now()-savedAt>800){await this.save(s);savedAt=Date.now();}
      }
      await handle.close();handle=null;
      if(!s.received_bytes||(s.total_bytes&&s.received_bytes!==s.total_bytes))throw fail('INCOMPLETE_NATIVE_FILE');
      const actual=checksum.digest('hex');if(expected&&actual!==expected.toLowerCase())throw fail('SHA256_MISMATCH');
      const target=path.join(this.inbox,s.import_id+'-'+s.filename);await rename(temporary,target);const st=await stat(target);
      Object.assign(s,{state:'complete',path:target,bytes:st.size,sha256:actual,sha256_matched:Boolean(expected),mtime_ms:st.mtimeMs,completed_at:Date.now(),transport:'native HTTPS original bytes; no recompression'});
    }catch(e){s.state='failed';s.error={code:/^[A-Z][A-Z0-9_]{2,64}$/.test(e.code||'')?e.code:'NATIVE_DOWNLOAD_FAILED'};if(e.host)s.error.host=e.host;}
    finally{await handle?.close().catch(()=>{});await unlink(temporary).catch(()=>{});await this.save(s);}
  }
  async exportFile(file,expected=''){
    await this.init();const resolved=await realpath(file),base=await realpath(this.exports),relative=path.relative(base,resolved);
    if(relative.startsWith('..')||path.isAbsolute(relative)||!relative||(await lstat(file)).isSymbolicLink())throw fail('FILE_OUTSIDE_EXPORTS');
    const st=await stat(resolved);if(!st.isFile()||!st.size||st.size>2*1024*1024*1024)throw fail('INVALID_EXPORT_FILE');
    const checksum=await sha256(resolved);if(expected&&expected.toLowerCase()!==checksum)throw fail('SHA256_MISMATCH');
    return {path:resolved,filename:path.basename(resolved),bytes:st.size,mtime_ms:st.mtimeMs,sha256:checksum,mime_type:TYPES[path.extname(resolved).toLowerCase()]||'application/octet-stream'};
  }
  async prepareDelivery(file,expected='',ttl=900){
    if(!Number.isInteger(ttl)||ttl<60||ttl>1800)throw fail('INVALID_EXPIRY');
    const receipt=await this.exportFile(file,expected);await this.ensurePublic();
    const token=randomBytes(32).toString('base64url');const expires=Date.now()+ttl*1000;
    this.grants.set(token,{...receipt,expires});this.lastUsed=Date.now();
    return {ok:true,mode:'delivery',...receipt,expires_at:expires,download_url:this.publicUrl+'/file/'+token+'/'+encodeURIComponent(receipt.filename),
      chat_delivery:'MCP file resource and inline download card. Not an invented sandbox attachment.'};
  }
  async ensurePublic(){
    if(this.publicPromise)return this.publicPromise;
    this.publicPromise=this.startPublic().catch(async e=>{await this.close();throw e;});return this.publicPromise;
  }
  async startPublic(){
    this.server=http.createServer((req,res)=>{void this.serve(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',resolve);});this.server.unref();
    const local='http://127.0.0.1:'+this.server.address().port;
    if(this.tunnelStarter){this.publicUrl=await this.tunnelStarter(local);return;}
    const binary=process.env.VCONTINUITY_CLOUDFLARED||path.join(os.homedir(),'Downloads','tunnel-client-runtime-cloudflared-v0.0.13-windows-amd64','cloudflared.exe');
    this.tunnel=spawn(binary,['tunnel','--no-autoupdate','--url',local,'--protocol','http2'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(fail('DELIVERY_HTTPS_NOT_READY')),30000);
      this.tunnel.once('error',()=>{clearTimeout(timer);reject(fail('DELIVERY_TUNNEL_UNAVAILABLE'));});
      this.tunnel.once('exit',()=>{this.publicPromise=null;this.publicUrl=null;clearTimeout(timer);reject(fail('DELIVERY_TUNNEL_STOPPED'));});
      this.tunnel.stderr.on('data',b=>{output=(output+b.toString()).slice(-24000);const match=output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);if(match&&output.includes('Registered tunnel connection')){this.publicUrl=match[0];clearTimeout(timer);resolve();}});
    });
    this.reaper=setInterval(()=>{const now=Date.now();for(const [k,g]of this.grants)if(g.expires<=now)this.grants.delete(k);if(!this.grants.size&&now-this.lastUsed>60000)void this.close();},15000);this.reaper.unref();
  }
  async serve(req,res){
    const origin=req.headers.origin;
    if(origin&&/^https:\/\/mcp-app-[a-z0-9-]+\.web-sandbox\.oaiusercontent\.com$/.test(origin))res.setHeader('Access-Control-Allow-Origin',origin);
    const parts=new URL(req.url,'http://127.0.0.1').pathname.split('/');const grant=parts[1]==='file'?this.grants.get(parts[2]):null;
    if(!['GET','HEAD'].includes(req.method)||!grant||grant.expires<=Date.now()||decodeURIComponent(parts[3]||'')!==grant.filename){res.writeHead(404);res.end();return;}
    let st;try{st=await stat(grant.path);}catch{res.writeHead(410);res.end();return;}if(st.size!==grant.bytes||st.mtimeMs!==grant.mtime_ms){res.writeHead(410);res.end();return;}
    let start=0,end=st.size-1,partial=false;
    if(req.headers.range){const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!m||(!m[1]&&!m[2])){res.writeHead(416);res.end();return;}
      start=m[1]?Number(m[1]):Math.max(0,st.size-Number(m[2]));end=m[1]&&m[2]?Math.min(end,Number(m[2])):end;
      if(start>end||start>=st.size){res.writeHead(416,{'Content-Range':'bytes */'+st.size});res.end();return;}partial=true;
    }
    res.setHeader('Content-Type',grant.mime_type);res.setHeader('Content-Length',end-start+1);res.setHeader('Cache-Control','no-store');res.setHeader('Accept-Ranges','bytes');
    res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(grant.filename));
    if(partial)res.setHeader('Content-Range',`bytes ${start}-${end}/${st.size}`);res.writeHead(partial?206:200);
    if(req.method==='HEAD'){res.end();return;}const stream=createReadStream(grant.path,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }
  async close(){clearInterval(this.reaper);this.tunnel?.kill();this.server?.closeIdleConnections?.();if(this.server)await new Promise(r=>this.server.close(r));this.publicPromise=null;this.publicUrl=null;this.grants.clear();}
}
export const fileTransferService=new FileTransferService();
