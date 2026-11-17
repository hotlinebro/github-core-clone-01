import { Buffer } from 'node:buffer';

type Selection = { name: string; alias: string; args: Record<string, any>; children: Selection[]; condition?: string };
type Context = {
  repos: Map<string, any>; allocate: () => number;
  merge: (repo: any, pull: any) => void;
  files: (repo: any, pull: any) => any[];
};
const schemaFields: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};
const shape: Record<string, Record<string,string>> = {
  Query: {viewer:'User', repository:'Repository', node:'Node', __type:'__Type', createIssue:'IssuePayload', closeIssue:'IssuePayload', createPullRequest:'PullPayload', mergePullRequest:'PullPayload', addComment:'CommentPayload'},
  User: {login:''}, Node: {id:''},
  Repository: {id:'', databaseId:'', name:'', nameWithOwner:'', owner:'User', defaultBranchRef:'Ref', viewerPermission:'', hasIssuesEnabled:'', issue:'Issue', issues:'IssueConnection', pullRequests:'PullConnection', pullRequest:'PullRequest'},
  Ref: {name:'', target:'Commit'}, Commit: {oid:''},
  Issue: {id:'', number:'', title:'', state:'', body:''},
  PullRequest: {id:'', number:'', title:'', body:'', headRefName:'', baseRefName:'', mergeable:'', state:'', merged:'', files:'FileConnection'},
  IssueConnection: {nodes:'Issue', pageInfo:'PageInfo', totalCount:''}, PullConnection: {nodes:'PullRequest', pageInfo:'PageInfo', totalCount:''},
  FileConnection: {nodes:'File', pageInfo:'PageInfo', totalCount:''}, File: {path:''}, PageInfo: {hasNextPage:'', endCursor:''},
  __Type: {name:'', fields:'__Field', enumValues:'__Field'}, __Field: {name:''},
  IssuePayload: {issue:'Issue'}, PullPayload: {pullRequest:'PullRequest'}, CommentPayload: {commentEdge:'CommentEdge'}, CommentEdge: {node:'Comment'}, Comment: {id:'', body:''},
};
function validate(fields: Selection[], type: string): void {
  for (const field of fields) {
    if (field.name === '...') {
      if (!shape[field.condition!]) throw new Error(`Unknown type '${field.condition}'`);
      validate(field.children, field.condition!); continue;
    }
    if (field.name === '__typename') continue;
    if (!Object.hasOwn(shape[type] ?? {}, field.name)) throw new Error(`Unknown field '${field.name}' on ${type}`);
    const child = shape[type][field.name];
    if (field.children.length) {
      if (!child) throw new Error(`Field '${field.name}' has no subfields`);
      validate(field.children, child);
    } else if (child) throw new Error(`Field '${field.name}' requires subfields`);
  }
}
function parse(source: string, variables: Record<string, any>, requested?: string): Selection[] {
  const tokens = source.match(/\s+|#[^\n]*|\.\.\.|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|[_A-Za-z][_0-9A-Za-z]*|[!$():={}\[\],@]/g)?.filter(t => !/^\s|^#|^,$/.test(t)) ?? [];
  let pos = 0;
  const take = () => { if (pos >= tokens.length) throw new Error('Unexpected end of query'); return tokens[pos++]; };
  const expect = (s: string) => { if (take() !== s) throw new Error(`Expected ${s}`); };
  const value = (): any => {
    const t = take();
    if (t === '$') return variables[take()];
    if (t === '[') { const a: any[] = []; while (tokens[pos] !== ']') a.push(value()); take(); return a; }
    if (t === '{') { const o: any = {}; while (tokens[pos] !== '}') { const k = take(); expect(':'); o[k] = value(); } take(); return o; }
    if (t.startsWith('"')) return JSON.parse(t);
    if (t === 'null') return null;
    if (t === 'true' || t === 'false') return t === 'true';
    if (/^-?\d/.test(t)) return Number(t);
    return t;
  };
  const selection = (): Selection[] => {
    expect('{'); const fields: Selection[] = [];
    while (tokens[pos] !== '}') {
      let name = take();
      if (name === '...') {
        expect('on'); const condition = take();
        fields.push({ name: '...', alias: '...', args: {}, children: selection(), condition }); continue;
      }
      let alias = name;
      if (tokens[pos] === ':') { take(); name = take(); }
      const args: Record<string, any> = {};
      if (tokens[pos] === '(') {
        take(); while (tokens[pos] !== ')') { const k = take(); expect(':'); args[k] = value(); } take();
      }
      const children = tokens[pos] === '{' ? selection() : [];
      fields.push({ name, alias, args, children });
    }
    take(); return fields;
  };
  const operations: { name?: string; fields: Selection[] }[] = [];
  while (pos < tokens.length) {
    let name: string | undefined;
    if (tokens[pos] !== '{') {
      const kind = take(); if (!['query', 'mutation'].includes(kind)) throw new Error('Unsupported operation');
      if (tokens[pos] !== '(' && tokens[pos] !== '{') name = take();
      if (tokens[pos] === '(') {
        take();
        while (tokens[pos] !== ')') {
          expect('$'); const variable = take(); expect(':');
          while (!['$', '=', ')'].includes(tokens[pos])) take();
          if (tokens[pos] === '=') { take(); const v = value(); if (variables[variable] === undefined) variables[variable] = v; }
        }
        take();
      }
    }
    operations.push({ name, fields: selection() });
  }
  const operation = requested ? operations.find(o => o.name === requested) : operations.length === 1 ? operations[0] : undefined;
  if (!operation) throw new Error('Operation name required or unknown');
  return operation.fields;
}
type Entity = { type: string; fields: Record<string, any> };
const entity = (type: string, fields: Record<string, any>): Entity => ({ type, fields });
export function executeGraphQL(body: any, context: Context): any {
  if (Array.isArray(body)) return body.map(b => executeGraphQL(b, context));
  try {
    const selections = parse(String(body?.query ?? ''), { ...body?.variables }, body?.operationName);
    validate(selections, 'Query');
    const { repos, allocate } = context;
    const find = (id: string): { repo: any; item: any; type: string } | undefined => {
      for (const r of repos.values()) {
        if (id === `R_${r.id}`) return { repo: r, item: r, type: 'Repository' };
        for (const i of r.issues.values()) if (id === `I_${i.id}`) return { repo: r, item: i, type: 'Issue' };
        for (const p of r.pulls.values()) if (id === `P_${p.id}`) return { repo: r, item: p, type: 'PullRequest' };
      }
    };
    const connection = (items: any[], args: any, wrap: (x: any) => any) => {
      const start = args.after ? Number(Buffer.from(args.after, 'base64').toString()) : 0;
      const first = Math.max(0, args.first ?? items.length), page = items.slice(start, start + first);
      return entity('Connection', { nodes: page.map(wrap), totalCount: items.length, pageInfo: entity('PageInfo', {
        hasNextPage: start + page.length < items.length,
        endCursor: page.length ? Buffer.from(String(start + page.length)).toString('base64') : null,
      }) });
    };
    const issue = (i: any): any => i ? entity('Issue', { id: `I_${i.id}`, number: i.number, title: i.title, body: i.body, state: i.state.toUpperCase() }) : null;
    const pull = (r: any, p: any): any => p ? entity('PullRequest', {
      id: `P_${p.id}`, number: p.number, title: p.title, body: p.body, state: p.merged ? 'MERGED' : p.state.toUpperCase(),
      merged: p.merged, mergeable: 'MERGEABLE', headRefName: p.head, baseRefName: p.base,
      files: (args: any) => connection(context.files(r, p), args, f => entity('PullRequestChangedFile', { path: f.filename })),
    }) : null;
    const repository = (r: any): any => r ? entity('Repository', {
      id: `R_${r.id}`, databaseId: r.id, name: r.name, nameWithOwner: `${r.owner}/${r.name}`,
      owner: entity('User', { login: r.owner }), viewerPermission: 'ADMIN', hasIssuesEnabled: true,
      defaultBranchRef: entity('Ref', { name: r.default_branch, target: entity('Commit', { oid: r.refs.get(`refs/heads/${r.default_branch}`) }) }),
      issue: (a: any) => issue(r.issues.get(a.number)), pullRequest: (a: any) => pull(r, r.pulls.get(a.number)),
      issues: (a: any) => {
        const items = [...r.issues.values()].filter((i: any) => !a.states || a.states.includes(i.state.toUpperCase()));
        items.sort((x: any, y: any) => a.orderBy?.direction === 'DESC' ? y.created - x.created || y.number - x.number : x.created - y.created || x.number - y.number);
        return connection(items, a, issue);
      },
      pullRequests: (a: any) => connection([...r.pulls.values()].filter((p: any) => !a.states || a.states.includes(p.state.toUpperCase())), a, p => pull(r, p)),
    }) : null;
    const mutation = (name: string, a: any): Entity => {
      const input = a.input ?? {}, found = find(input.repositoryId ?? input.issueId ?? input.pullRequestId ?? input.subjectId);
      if (!found) throw new Error('Unknown mutation target');
      const r = found.repo;
      if (name === 'createIssue') {
        const number = Math.max(0, ...r.issues.keys()) + 1;
        const i = { id: allocate(), number, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open', labels: [], comments: [], created: number };
        r.issues.set(number, i); return entity('CreateIssuePayload', { issue: issue(i) });
      }
      if (name === 'closeIssue') { found.item.state = 'closed'; return entity('CloseIssuePayload', { issue: issue(found.item) }); }
      if (name === 'createPullRequest') {
        const number = Math.max(0, ...r.pulls.keys()) + 1;
        const p = { id: allocate(), number, title: String(input.title ?? ''), body: String(input.body ?? ''), head: input.headRefName, base: input.baseRefName, state: 'open', merged: false, merge_commit_sha: null, comments: [] };
        r.pulls.set(number, p); return entity('CreatePullRequestPayload', { pullRequest: pull(r, p) });
      }
      if (name === 'mergePullRequest') { context.merge(r, found.item); return entity('MergePullRequestPayload', { pullRequest: pull(r, found.item) }); }
      const c = { id: allocate(), body: String(input.body ?? '') };
      (found.item.comments ??= []).push(c);
      return entity('AddCommentPayload', { commentEdge: entity('CommentEdge', { node: entity('IssueComment', { id: `C_${c.id}`, body: c.body }) }) });
    };
    const root = entity('Query', {
      viewer: entity('User', { login: 'adaiversen' }),
      repository: (a: any) => repository([...repos.values()].find(r => r.owner.toLowerCase() === String(a.owner).toLowerCase() && r.name.toLowerCase() === String(a.name).toLowerCase())),
      node: (a: any) => { const f = find(a.id); return f ? f.type === 'Repository' ? repository(f.repo) : f.type === 'Issue' ? issue(f.item) : pull(f.repo, f.item) : null; },
      __type: (a: any) => entity('__Type', { name: a.name, fields: (schemaFields[a.name] ?? []).map(name => entity('__Field', { name })), enumValues: a.name === 'SearchType' ? ['ISSUE', 'REPOSITORY'].map(name => entity('__EnumValue', { name })) : null }),
      ...Object.fromEntries(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'].map(name => [name, (a: any) => mutation(name, a)])),
    });
    const project = (object: any, fields: Selection[]): any => {
      if (object == null) return null;
      if (Array.isArray(object)) return object.map(o => project(o, fields));
      const result: Record<string, any> = {};
      for (const field of fields) {
        if (field.name === '...') { if (field.condition === object.type) Object.assign(result, project(object, field.children)); continue; }
        if (field.name === '__typename') { result[field.alias] = object.type; continue; }
        if (!Object.hasOwn(object.fields ?? {}, field.name)) throw new Error(`Unknown field '${field.name}' on ${object.type}`);
        let value = object.fields[field.name]; if (typeof value === 'function') value = value(field.args);
        result[field.alias] = field.children.length ? project(value, field.children) : value;
      }
      return result;
    };
    return { data: project(root, selections) };
  } catch (error) { return { errors: [{ message: error instanceof Error ? error.message : String(error) }] }; }
}
