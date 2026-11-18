import { createHash } from 'node:crypto';
import { packet as pkt, decodePack, sideband, uploadResponse } from './pack.ts';
import { executeGraphQL } from './graphql.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Obj = { type: string; data: Buffer };
type Issue = { id: number; number: number; title: string; body: string; state: string; labels: { name: string; color: string }[]; comments: { id: number; body: string }[]; created: number };
type Pull = { id: number; number: number; title: string; body: string; state: string; head: string; base: string; merged: boolean; merge_commit_sha: string | null };
type Repo = { id: number; owner: string; name: string; description: string; private: boolean; default_branch: string; refs: Map<string,string>; objects: Map<string,Obj>; issues: Map<number,Issue>; pulls: Map<number,Pull>; labels: Map<string,string>; contents: Map<string,{sha:string;data:Buffer}>; branches: Map<string,string> };
const repos = new Map<string,Repo>();
// V2 perf: the v2 capability advertisement is constant bytes. Build it once
// instead of ~15 Buffer allocations on every info/refs request (the clone flow
// alone asks for it 3 times per clone).
const V2_ADVERTISEMENT = Buffer.concat([pkt('version 2\n'), pkt('agent=forge/1\n'), pkt('ls-refs=unborn\n'), pkt('fetch=shallow wait-for-done filter\n'), pkt('server-option\n'), pkt('object-format=sha1\n'), flush()]);
let nextId = 1000;
const key = (o: string, r: string) => `${o.toLowerCase()}/${r.toLowerCase()}`;
const oid = (type: string, data: Buffer) => createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
function put(repo: Repo, type: string, data: Buffer): string { const id = oid(type,data); repo.objects.set(id,{type,data}); return id; }
function utf(s: string): Buffer { return Buffer.from(s,'utf8'); }
function makeCommit(repo: Repo, tree: string, parents: string[], message: string, who = 'Forge User <forge@example.invalid>'): string {
  const meta = `${who} 1735689600 +0000`;
  const body = `tree ${tree}\n${parents.map(p=>`parent ${p}\n`).join('')}author ${meta}\ncommitter ${meta}\n\n${message}\n`;
  return put(repo,'commit',utf(body));
}
function treeFiles(repo: Repo, tree: string, prefix = '', output = new Map<string,{sha:string;data:Buffer}>()) {
  const bytes = repo.objects.get(tree)?.data ?? Buffer.alloc(0);
  let cursor = 0;
  while (cursor < bytes.length) {
    const space = bytes.indexOf(32, cursor), zero = bytes.indexOf(0, space);
    if (space < 0 || zero < 0 || zero + 21 > bytes.length) throw new Error('Invalid tree');
    const mode = bytes.toString('ascii', cursor, space), name = bytes.toString('utf8', space + 1, zero);
    const sha = bytes.subarray(zero + 1, zero + 21).toString('hex');
    if (mode === '40000' || mode === '040000') treeFiles(repo, sha, prefix + name + '/', output);
    else output.set(prefix + name, {sha, data:repo.objects.get(sha)?.data ?? Buffer.alloc(0)});
    cursor = zero + 21;
  }
  return output;
}
function branchFiles(repo: Repo, branch: string) {
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(branch);
  const tree = /^tree ([0-9a-f]{40})/m.exec(repo.objects.get(tip ?? '')?.data.toString() ?? '')?.[1];
  return tree ? treeFiles(repo, tree) : new Map<string,{sha:string;data:Buffer}>();
}
function pullHasConflict(repo: Repo, pull: Pull, baseTip: string | undefined, headTip: string): boolean {
  const firstParent = (commit: string) => {
    const headers = repo.objects.get(commit)?.data.toString().split('\n\n', 1)[0] ?? '';
    return /^parent (\S+)$/m.exec(headers)?.[1];
  };
  const ancestors = new Set<string>();
  let cursor: string | undefined = headTip;
  while (cursor && !ancestors.has(cursor)) {
    ancestors.add(cursor);
    cursor = firstParent(cursor);
  }
  const visited = new Set<string>();
  cursor = baseTip;
  while (cursor && !ancestors.has(cursor) && !visited.has(cursor)) {
    visited.add(cursor);
    cursor = firstParent(cursor);
  }
  const common = cursor && ancestors.has(cursor) ? cursor : undefined;
  if (common === headTip) return false;
  const snapshot = common ? repo.objects.get(common)?.data.toString().split('\n', 1)[0].slice(5) : undefined;
  const original = snapshot ? treeFiles(repo, snapshot) : new Map<string, {sha: string; data: Buffer}>();
  const incoming = branchFiles(repo, pull.head);
  const current = branchFiles(repo, pull.base);
  const same = (left: {data: Buffer} | undefined, right: {data: Buffer} | undefined) =>
    left === undefined ? right === undefined : right !== undefined && left.data.equals(right.data);
  for (const path of new Set([...original.keys(), ...incoming.keys(), ...current.keys()])) {
    const before = original.get(path), ours = current.get(path), theirs = incoming.get(path);
    if (!same(theirs, before) && !same(ours, before) && !same(ours, theirs)) return true;
  }
  return false;
}
function writeFiles(repo: Repo, files: Map<string,{sha:string;data:Buffer}>, branch: string, message: string) {
  const entries = new Map([...files].map(([path, file]) => [path, {sha:file.sha, mode:'100644'}]));
  const parent = repo.refs.get(`refs/heads/${branch}`);
  const sha = makeCommit(repo, commitTree(repo, entries), parent ? [parent] : [], message);
  repo.refs.set(`refs/heads/${branch}`, sha); repo.branches.set(branch, sha);
  if (branch === repo.default_branch) repo.contents = files;
  return sha;
}
function pullFiles(repo: Repo, pull: Pull) {
  const base = branchFiles(repo, pull.base), head = branchFiles(repo, pull.head);
  const result: any[] = [];
  for (const path of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const before = base.get(path), after = head.get(path);
    if (before?.sha === after?.sha) continue;
    const lines = (data?: Buffer) => data?.length ? data.toString().split('\n').length - (data.at(-1) === 10 ? 1 : 0) : 0;
    const additions = lines(after?.data), deletions = lines(before?.data);
    result.push({filename:path, sha:after?.sha ?? before?.sha, status:!before?'added':!after?'removed':'modified', additions, deletions, changes:additions+deletions});
  }
  return result;
}
function mergePull(repo: Repo, pull: Pull) {
  const head = repo.refs.get(`refs/heads/${pull.head}`);
  const tree = /^tree ([0-9a-f]{40})/m.exec(repo.objects.get(head ?? '')?.data.toString() ?? '')?.[1];
  if (!tree) throw new Error('Head branch missing');
  const branch = repo.default_branch, parent = repo.refs.get(`refs/heads/${branch}`);
  const sha = makeCommit(repo, tree, parent ? [parent] : [], `Merge pull request #${pull.number}`);
  repo.refs.set(`refs/heads/${branch}`, sha); repo.branches.set(branch, sha);
  repo.contents = treeFiles(repo, tree); pull.merged = true; pull.state = 'closed'; pull.merge_commit_sha = sha;
}
function emptyTree(repo: Repo): string { return put(repo,'tree',Buffer.alloc(0)); }
function newRepo(owner: string, name: string, description = '', priv = false): Repo {
  const repo: Repo = { id: nextId++, owner, name, description, private:priv, default_branch:'main', refs:new Map(), objects:new Map(), issues:new Map(), pulls:new Map(), labels:new Map(), contents:new Map(), branches:new Map() };
  repos.set(key(owner,name),repo); return repo;
}
function repoJson(r: Repo): object { return { id:r.id,node_id:`R_${r.id}`,name:r.name,full_name:`${r.owner}/${r.name}`,owner:{login:r.owner,id:1,type:'User'},private:r.private,description:r.description,default_branch:r.default_branch,has_issues:true,html_url:`http://forge/${r.owner}/${r.name}`,url:`/api/v3/repos/${r.owner}/${r.name}` }; }
function commitTree(repo: Repo, entries: Map<string,{sha:string;mode:string}>): string {
  type Node = { files: Map<string,{sha:string;mode:string}>; dirs: Map<string,Node> };
  const root:Node={files:new Map(),dirs:new Map()};
  for(const [path,val] of entries){const parts=path.split('/');let n=root;for(const p of parts.slice(0,-1)){if(!n.dirs.has(p))n.dirs.set(p,{files:new Map(),dirs:new Map()});n=n.dirs.get(p)!;}n.files.set(parts.at(-1)!,val);}
  const emit = (node: Node): string => {
    const entries = [...node.files].map(([name, file]) => ({name, mode:file.mode, sha:file.sha, directory:false}));
    for (const [name, child] of node.dirs) entries.push({name, mode:'40000', sha:emit(child), directory:true});
    entries.sort((a,b) => Buffer.compare(Buffer.from(a.name + (a.directory ? '/' : '')), Buffer.from(b.name + (b.directory ? '/' : ''))));
    return put(repo, 'tree', Buffer.concat(entries.map(e => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')]))));
  };
  return emit(root);
}
async function readBody(req: IncomingMessage): Promise<Buffer> { const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));return Buffer.concat(chunks); }
function send(res:ServerResponse,status:number,body:unknown,headers:Record<string,string>={}){res.statusCode=status;for(const [k,v] of Object.entries(headers))res.setHeader(k,v);if(body===null){res.end();return;}if(Buffer.isBuffer(body)){res.end(body);return;}res.setHeader('content-type','application/json; charset=utf-8');res.end(JSON.stringify(body));}
function flush():Buffer{return Buffer.from('0000');}
function parsePkt(b:Buffer):Buffer[]{const out:Buffer[]=[];for(let i=0;i+4<=b.length;){const n=parseInt(b.subarray(i,i+4).toString(),16);i+=4;if(n<=4)continue;if(i+n-4>b.length)break;out.push(b.subarray(i,i+n-4));i+=n-4;}return out;}
function authLogin(req:IncomingMessage):string|null{const token=(req.headers.authorization??'').replace(/^Bearer\s+/i,'');if(!token||token!==process.env.MAKEFUN_SHOP_TOKEN)return null;return 'adaiversen';}
function issueJson(i:Issue,r:Repo){return {id:i.id,node_id:`I_${i.id}`,number:i.number,title:i.title,body:i.body,state:i.state,labels:i.labels,user:{login:r.owner},comments:i.comments.length,created_at:'2025-01-01T00:00:00Z',html_url:`http://forge/${r.owner}/${r.name}/issues/${i.number}`};}
function pullJson(p:Pull,r:Repo){const headSha=r.refs.get(`refs/heads/${p.head}`)??r.refs.get(p.head)??'';const baseSha=r.refs.get(`refs/heads/${p.base}`)??r.refs.get(p.base)??'';return {id:p.id,number:p.number,title:p.title,body:p.body,state:p.state,head:{ref:p.head,sha:headSha,repo:repoJson(r)},base:{ref:p.base,sha:baseSha,repo:repoJson(r)},merged:p.merged,mergeable:true,merge_commit_sha:p.merge_commit_sha,merged_at:p.merged?'2025-01-01T00:00:00Z':null,changed_files:0};}

export function createApp(){
 return async (req:IncomingMessage,res:ServerResponse)=>{
  const url=new URL(req.url??'/',`http://${req.headers.host??'localhost'}`), path=url.pathname;
  if(path==='/healthz'){send(res,200,{ok:true});return;}
  if(path.startsWith('/api/v3')){await rest(req,res,url);return;}
  if(path==='/api/graphql'){await graphql(req,res);return;}
  if(path==='/mcp'){await mcp(req,res);return;}
  if(path.endsWith('/info/refs')||path.endsWith('/git-upload-pack')||path.endsWith('/git-receive-pack')){await git(req,res,url);return;}
  send(res,404,{message:'Not Found'});
 };
}

async function rest(req:IncomingMessage,res:ServerResponse,url:URL){
 const p=url.pathname.replace(/^\/api\/v3\/?/,'');const method=req.method??'GET';const login=authLogin(req);const headers={'X-GitHub-Request-Id':'forge0001'};
 if(!login){send(res,401,{message:'Bad credentials'},headers);return;}
 let body:any={};if(!['GET','HEAD','DELETE'].includes(method)){try{const b=await readBody(req);if(b.length)body=JSON.parse(b.toString());}catch{send(res,400,{message:'Invalid JSON'},headers);return;}}
 if(p===''&&method==='GET'){send(res,200,{current_user_url:'/user',repository_url:'/repos/{owner}/{repo}'},{...headers,'X-OAuth-Scopes':'repo, read:org'});return;}
 if(p==='meta'){send(res,200,{installed_version:'3.0.0'},headers);return;}
 if(p==='user'){send(res,200,{login,id:1,type:'User'},headers);return;}
 if(p==='user/repos'&&method==='GET'){const all=[...repos.values()].filter(r=>r.owner===login);const page=Math.max(1,Number(url.searchParams.get('page')??1)), per=Math.max(1,Math.min(100,Number(url.searchParams.get('per_page')??30)));const result=all.slice((page-1)*per,page*per);const hs={...headers};if(page*per<all.length)hs.Link=`<${url.origin}${url.pathname}?per_page=${per}&page=${page+1}>; rel="next", <${url.origin}${url.pathname}?per_page=${per}&page=${Math.ceil(all.length/per)}>; rel="last"`;send(res,200,result.map(repoJson),hs);return;}
 if(p==='user/repos'&&method==='POST'){const n=String(body.name??'');if(!n){send(res,422,{message:'name is required'},headers);return;}const k=key(login,n);if(repos.has(k)){send(res,422,{message:'Repository already exists'},headers);return;}const r=newRepo(login,n,String(body.description??''),Boolean(body.private));send(res,201,repoJson(r),headers);return;}
 const m=p.match(/^repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);if(!m){send(res,404,{message:'Not Found'},headers);return;}const [,owner,name,sub='']=m;if(owner.toLowerCase()!==login.toLowerCase()){send(res,404,{message:'Not Found'},headers);return;}const r=repos.get(key(owner,name));if(!r){send(res,404,{message:'Not Found'},headers);return;}
 if(!sub&&method==='GET'){send(res,200,repoJson(r),headers);return;}if(!sub&&method==='PATCH'){if(body.description!==undefined)r.description=String(body.description);send(res,200,repoJson(r),headers);return;}if(!sub&&method==='DELETE'){repos.delete(key(owner,name));send(res,204,null,headers);return;}
 if(sub==='branches'&&method==='GET'){send(res,200,[...r.branches].map(([n,s])=>({name:n,commit:{sha:s}})),headers);return;}
 if(sub==='git/refs'&&method==='POST'){const ref=String(body.ref??'');const sha=String(body.sha??body.object?.sha??'');if(!ref||!r.objects.has(sha)){send(res,422,{message:'Invalid ref'},headers);return;}r.refs.set(ref,sha);r.branches.set(ref.replace(/^refs\/heads\//,''),sha);send(res,201,{ref,object:{sha}},headers);return;}
 if(sub==='commits'&&method==='GET'){const sha=url.searchParams.get('sha')??`refs/heads/${r.default_branch}`;const tip=r.refs.get(sha)??r.refs.get(`refs/heads/${sha}`);let arr:any[]=[];let cur=tip;while(cur&&arr.length<30){const o=r.objects.get(cur);if(!o||o.type!=='commit')break;const text=o.data.toString();const tree=/^tree ([^\n]+)/m.exec(text)?.[1]??'';arr.push({sha:cur,commit:{message:text.split('\n\n').at(-1)?.trim()??'',tree:{sha:tree}}});cur=/^parent ([^\n]+)/m.exec(text)?.[1];}send(res,200,arr,headers);return;}
 if(sub==='labels'&&method==='POST'){const n=String(body.name??'');r.labels.set(n,String(body.color??'ededed'));send(res,201,{id:nextId++,name:n,color:String(body.color??'ededed')},headers);return;}
 if(sub==='issues'&&method==='POST'){const names=Array.isArray(body.labels)?body.labels.map((x:any)=>typeof x==='string'?x:x.name):[];if(names.some((x:string)=>!r.labels.has(x))){send(res,422,{message:'Validation failed: label does not exist'},headers);return;}const num=r.issues.size+1;const i:Issue={id:nextId++,number:num,title:String(body.title??''),body:String(body.body??''),state:'open',labels:names.map((n:string)=>({name:n,color:r.labels.get(n)!})),comments:[],created:num};r.issues.set(num,i);send(res,201,issueJson(i,r),headers);return;}
 if(sub==='issues'&&method==='GET'){const state=url.searchParams.get('state')??'open';let a=[...r.issues.values()].filter(i=>state==='all'||i.state===state);const dir=url.searchParams.get('direction')??'desc';a.sort((x,y)=>dir==='asc'?x.number-y.number:y.number-x.number);send(res,200,a.map(i=>issueJson(i,r)),headers);return;}
 const im=sub.match(/^issues\/(\d+)(?:\/(comments))?$/);if(im){const i=r.issues.get(Number(im[1]))??(im[2]?r.pulls.get(Number(im[1])):undefined);if(i&&im[2]&&!(i as any).comments)(i as any).comments=[];if(!i){send(res,404,{message:'Not Found'},headers);return;}if(im[2]==='comments'&&method==='POST'){const c={id:nextId++,body:String(body.body??'')};i.comments.push(c);send(res,201,c,headers);return;}if(im[2]==='comments'&&method==='GET'){send(res,200,i.comments,headers);return;}if(method==='GET'){send(res,200,issueJson(i,r),headers);return;}if(method==='PATCH'){if(body.state)i.state=String(body.state);send(res,200,issueJson(i,r),headers);return;}}
 if(sub==='pulls'&&method==='POST'){const num=r.pulls.size+1;const head=String(body.head??''),base=String(body.base??r.default_branch);const pull:Pull={id:nextId++,number:num,title:String(body.title??''),body:String(body.body??''),state:'open',head,base,merged:false,merge_commit_sha:null};r.pulls.set(num,pull);send(res,201,pullJson(pull,r),headers);return;}
 if(sub==='pulls'&&method==='GET'){const state=url.searchParams.get('state')??'open';send(res,200,[...r.pulls.values()].filter(q=>state==='all'||q.state===state).map(q=>pullJson(q,r)),headers);return;}
 const pm=sub.match(/^pulls\/(\d+)(?:\/(files|merge))?$/);if(pm){const q=r.pulls.get(Number(pm[1]));if(!q){send(res,404,{message:'Not Found'},headers);return;}if(pm[2]==='files'){send(res,200,pullFiles(r,q),headers);return;}if(pm[2]==='merge'&&method==='PUT'){const base=r.refs.get(`refs/heads/${q.base}`),head=r.refs.get(`refs/heads/${q.head}`);if(!head){send(res,405,{message:'Head branch missing'},headers);return;}if(pullHasConflict(r,q,base,head)){send(res,405,{message:'Pull request has conflicting changes'},headers);return;}const old=r.objects.get(head),tree=/^tree ([^\n]+)/m.exec(old?.data.toString()??'')?.[1]??emptyTree(r);const sha=makeCommit(r,tree,base?[base]:[],`Merge pull request #${q.number}`);r.refs.set(`refs/heads/${q.base}`,sha);r.branches.set(q.base,sha);q.state='closed';q.merged=true;q.merge_commit_sha=sha;send(res,200,{sha,merged:true,message:'Pull request successfully merged'},headers);return;}if(method==='GET'){send(res,200,pullJson(q,r),headers);return;}}
 if(sub.startsWith('contents/')){const branch=String(body.branch??url.searchParams.get('ref')??url.searchParams.get('branch')??r.default_branch);const files=branchFiles(r,branch);const path=decodeURIComponent(sub.slice(9));if(method==='GET'){const f=files.get(path);if(!f){const prefix=path.replace(/\/?$/,'/');const children=[...files].filter(([k])=>k.startsWith(prefix));if(children.length){send(res,200,children.map(([k,v])=>({type:'file',name:k.slice(prefix.length),path:k,sha:v.sha})),headers);return;}send(res,404,{message:'Not Found'},headers);return;}send(res,200,{type:'file',name:path.split('/').at(-1),path,sha:f.sha,size:f.data.length,encoding:'base64',content:f.data.toString('base64')},headers);return;}if(method==='PUT'){const prior=files.get(path), given=body.sha;if(prior&&given!==prior.sha){send(res,409,{message:'sha does not match'},headers);return;}const data=Buffer.from(String(body.content??''),'base64'), blob=put(r,'blob',data);files.set(path,{sha:blob,data});const commit=writeFiles(r,files,branch,String(body.message??'Update '+path));send(res,prior?200:201,{content:{name:path.split('/').at(-1),path,sha:blob,encoding:'base64'},commit:{sha:commit}},headers);return;}if(method==='DELETE'){if(!files.has(path)){send(res,404,{message:'Not Found'},headers);return;}files.delete(path);const commit=writeFiles(r,files,branch,String(body.message??'Delete '+path));send(res,200,{commit:{sha:commit}},headers);return;}}
 send(res,404,{message:'Not Found'},headers);
}

async function git(req:IncomingMessage,res:ServerResponse,url:URL){
 if(!authLogin(req)){send(res,401,{message:'Unauthorized'});return;}
 const bits=url.pathname.split('/').filter(Boolean);if(bits.length<2){res.statusCode=404;res.end();return;}const owner=bits[0]!,name=bits[1]!.replace(/\.git$/,''),r=repos.get(key(owner,name));if(!r){res.statusCode=404;res.end();return;}
 const receive=bits.at(-1)==='git-receive-pack'||url.searchParams.get('service')==='git-receive-pack';const service=receive?'git-receive-pack':'git-upload-pack';
 if(bits.slice(-2).join('/')==='info/refs'){
  const v2=!receive&&req.headers['git-protocol']==='version=2';res.statusCode=200;res.setHeader('content-type',`application/x-${service}-advertisement`);res.setHeader('cache-control','no-cache');
  if(v2){res.end(V2_ADVERTISEMENT);return;}
  const cap=receive?'report-status side-band-64k delete-refs ofs-delta agent=forge/1':'multi_ack_detailed side-band-64k thin-pack no-progress ofs-delta shallow deepen-since deepen-not deepen-relative agent=forge/1';const out=[pkt(`# service=${service}\n`),flush()];const head=r.refs.get(`refs/heads/${r.default_branch}`);if(head)out.push(pkt(`${head} HEAD\0${cap} symref=HEAD:refs/heads/${r.default_branch}\n`));for(const [ref,sha] of r.refs)out.push(pkt(`${sha} ${ref}\n`));if(!r.refs.size)out.push(pkt(`${'0'.repeat(40)} capabilities^{}\0${cap}\n`));out.push(flush());res.end(Buffer.concat(out));return;
 }
 const raw=await readBody(req);
 if(!receive){
   const lines=parsePkt(raw).map(b=>b.toString());
   res.statusCode=200;res.setHeader('content-type','application/x-git-upload-pack-result');
   res.end(uploadResponse(r,lines,req.headers['git-protocol']==='version=2'));return;
 }

 let unpackError=false;const packets=parsePkt(raw);const packStart=raw.indexOf(Buffer.from('PACK'));if(packStart>=0){try{const objs=decodePack(raw.subarray(packStart),r.objects);for(const [id,o] of objs)r.objects.set(id,o);}catch{unpackError=true;}}
 if(unpackError){res.setHeader('content-type','application/x-git-receive-pack-result');res.end(sideband(Buffer.concat([pkt('unpack invalid pack\n'),flush()])));return;}
 const statuses:string[]=[];for(const p of packets){const s=p.toString();const m=/^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\0\n]+)\0?/.exec(s);if(!m)continue;const [,oldSha,newSha,ref]=m;if(newSha==='0'.repeat(40)){r.refs.delete(ref!);r.branches.delete(ref!.replace(/^refs\/heads\//,''));statuses.push(`ok ${ref}\n`);}else if(oldSha==='0'.repeat(40)||isAncestor(r,oldSha!,newSha!)){r.refs.set(ref!,newSha!);r.branches.set(ref!.replace(/^refs\/heads\//,''),newSha!);statuses.push(`ok ${ref}\n`);}else statuses.push(`ng ${ref} non-fast-forward\n`);}
 const report=Buffer.concat([pkt('unpack ok\n'),...statuses.map(s=>pkt(s)),flush()]);res.statusCode=200;res.setHeader('content-type','application/x-git-receive-pack-result');res.end(sideband(report));
}
function isAncestor(r:Repo,a:string,b:string):boolean{if(a===b)return true;const seen=new Set<string>();const walk=(x:string):boolean=>{if(x===a)return true;if(seen.has(x))return false;seen.add(x);const s=r.objects.get(x)?.data.toString()??'';const p=[...s.matchAll(/^parent ([0-9a-f]{40})/gm)];return p.some(m=>walk(m[1]!));};return walk(b);}

async function mcp(req:IncomingMessage,res:ServerResponse){const login=authLogin(req);if(!login){send(res,401,{message:'Unauthorized'});return;}let b:any;try{b=JSON.parse((await readBody(req)).toString());}catch{send(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});return;}const reply=(result:unknown)=>send(res,200,{jsonrpc:'2.0',id:b.id??null,result});if(b.method==='notifications/initialized'){res.statusCode=202;res.end();return;}if(b.method==='initialize'){reply({protocolVersion:b.params?.protocolVersion??'2026-07-28',capabilities:{tools:{}},serverInfo:{name:'forge',version:'1.0.0'}});return;}if(b.method==='server/discover'){reply({capabilities:{tools:{}},supportedVersions:['2026-07-28'],serverInfo:{name:'forge',version:'1.0.0'},_meta:{'io.modelcontextprotocol/serverInfo':{name:'forge',version:'1.0.0'}}});return;}if(b.method==='tools/list'){reply({tools:MCP_TOOLS});return;}if(b.method!=='tools/call'){send(res,200,{jsonrpc:'2.0',id:b.id??null,error:{code:-32601,message:'Method not found'}});return;}const tool=String(b.params?.name??'').replace(/^github__/i,'').toLowerCase(),a=b.params?.arguments??{};let data:any;
 try{if(tool==='create_repo'){const r=newRepo(login,String(a.name??''),String(a.description??''),Boolean(a.private));data=repoJson(r);}else if(tool==='get_repo'){const r=repos.get(key(String(a.owner??login),String(a.repo??'')));if(!r)throw new Error('Not Found');data=repoJson(r);}else if(tool==='create_issue'){const r=repos.get(key(String(a.owner??login),String(a.repo??'')));if(!r)throw new Error('Not Found');const number=r.issues.size+1,i:Issue={id:nextId++,number,title:String(a.title??''),body:String(a.body??''),state:'open',labels:[],comments:[],created:number};r.issues.set(number,i);data=issueJson(i,r);}else if(tool==='list_issues'){const r=repos.get(key(String(a.owner??login),String(a.repo??'')));if(!r)throw new Error('Not Found');data=[...r.issues.values()].filter(i=>!a.state||a.state==='all'||i.state===a.state).map(i=>issueJson(i,r));}else if(tool==='create_pull_request'){const r=repos.get(key(String(a.owner??login),String(a.repo??'')));if(!r)throw new Error('Not Found');const number=r.pulls.size+1,q:Pull={id:nextId++,number,title:String(a.title??''),body:'',state:'open',head:String(a.head??''),base:String(a.base??'main'),merged:false,merge_commit_sha:null};r.pulls.set(number,q);data=pullJson(q,r);}else if(tool==='merge_pull_request'){const r=repos.get(key(String(a.owner??login),String(a.repo??'')));if(!r)throw new Error('Not Found');const q=r.pulls.get(Number(a.pull_number));if(!q)throw new Error('Not Found');const tip=r.refs.get(`refs/heads/${q.head}`);if(!tip)throw new Error('Head branch missing');const tree=/^tree ([^\n]+)/m.exec(r.objects.get(tip)?.data.toString()??'')?.[1]??emptyTree(r);const sha=makeCommit(r,tree,[r.refs.get(`refs/heads/${q.base}`)??''].filter(Boolean),`Merge pull request #${q.number}`);r.refs.set(`refs/heads/${q.base}`,sha);q.merged=true;q.state='closed';q.merge_commit_sha=sha;data={sha,merged:true,message:'Pull request successfully merged'};}else{send(res,200,{jsonrpc:'2.0',id:b.id??null,error:{code:-32602,message:'Unknown tool'}});return;}reply({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});}catch(e){reply({content:[{type:'text',text:e instanceof Error?e.message:'Error'}],isError:true});}}
const MCP_TOOLS=[['create_repo','Create a repository',['name']],['get_repo','Get a repository',['owner','repo']],['create_issue','Create an issue',['owner','repo','title']],['list_issues','List repository issues',['owner','repo']],['create_pull_request','Create a pull request',['owner','repo','title','head','base']],['merge_pull_request','Merge a pull request',['owner','repo','pull_number']]].map(([name,description,required])=>({name,description,inputSchema:{type:'object',properties:Object.fromEntries((required as string[]).map(x=>[x,{type:x==='pull_number'?'integer':'string'}])),required}}));

async function graphql(req: IncomingMessage, res: ServerResponse) {
 if (!authLogin(req)) { send(res, 401, {message:'Unauthorized'}); return; }
 let body: any;
 try { body = JSON.parse((await readBody(req)).toString()); }
 catch { send(res, 400, {message:'Invalid JSON'}); return; }
 send(res, 200, executeGraphQL(body, {repos, allocate: () => nextId++, merge: mergePull, files: pullFiles}));
}
