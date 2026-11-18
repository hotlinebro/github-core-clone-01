import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

type ObjectData = { type: string; data: Buffer };
const kinds = ['', 'commit', 'tree', 'blob', 'tag'];
// V1 perf: objects are immutable and content-addressed, so a parsed children list
// never goes stale. Cache it by object id + parents flag; the clone walk re-parses
// the same commits on every clone otherwise (regex matchAll over toString()).
const childrenCache = new Map<string, string[]>();
// V1 perf: identical clone requests (same wants/haves/depth, same object set) get
// the identical pack bytes. Cache the whole upload-pack response per repo object;
// the key carries the object count because a repo's object set only ever grows, so
// equal size on one repo's timeline means equal content. Cap the map so a trial
// with many distinct clones cannot grow it without bound.
const packCache = new WeakMap<object, Map<string, Buffer>>();
// V2 perf: ls-refs answers are pure functions of (refs, default_branch,
// prefixes, peel). Cache the built bytes per repo.
const lsRefsCache = new WeakMap<object, Map<string, Buffer>>();
function hash(o: ObjectData): string {
  return createHash('sha1').update(`${o.type} ${o.data.length}\0`).update(o.data).digest('hex');
}
export function packet(payload: string | Buffer): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (data.length + 4 > 65520) throw new Error('Packet too large');
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}
export function encodePack(objects: Iterable<ObjectData>): Buffer {
  const list = [...objects], header = Buffer.alloc(12);
  header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(list.length, 8);
  const chunks = [header];
  for (const o of list) {
    const type = kinds.indexOf(o.type);
    if (type < 1) throw new Error('Unsupported object type');
    let size = o.data.length;
    const bytes = [(type << 4) | (size & 15)];
    size = Math.floor(size / 16);
    while (size) {
      bytes[bytes.length - 1] |= 128;
      bytes.push(size & 127); size = Math.floor(size / 128);
    }
    chunks.push(Buffer.from(bytes), deflateSync(o.data));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
export function sideband(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 65514) {
    chunks.push(packet(Buffer.concat([Buffer.from([1]), data.subarray(offset, offset + 65514)])));
  }
  chunks.push(Buffer.from('0001'));
  return Buffer.concat(chunks);
}
export function uploadResponse(repo: {objects: Map<string,ObjectData>; refs: Map<string,string>; default_branch:string}, lines: string[], v2: boolean): Buffer {
  if (lines.some(line => line.trim() === 'command=ls-refs')) {
    const prefixes = lines.filter(l => l.startsWith('ref-prefix ')).map(l => l.slice(11).trim());
    const peel = lines.some(l => l.trim() === 'peel');
    // V2 perf: cache the ls-refs bytes. Key covers every input: default branch,
    // prefixes, peel flag, and every ref pair (a moved ref changes the key).
    const lsKey = [repo.default_branch, prefixes.join(','), peel ? 'peel' : '', [...repo.refs.entries()].sort().map(([n, s]) => `${n}=${s}`).join(',')].join('|');
    let repoLsCache = lsRefsCache.get(repo);
    if (!repoLsCache) { repoLsCache = new Map(); lsRefsCache.set(repo, repoLsCache); }
    const lsHit = repoLsCache.get(lsKey);
    if (lsHit) return lsHit;
    const refs = new Map(repo.refs), head = `refs/heads/${repo.default_branch}`;
    if (refs.has(head)) refs.set('HEAD', refs.get(head)!);
    const packets: Buffer[] = [];
    for (const [name, sha] of refs) {
      if (prefixes.length && !prefixes.some(p => name.startsWith(p))) continue;
      let suffix = name === 'HEAD' ? ` symref-target:${head}` : '';
      if (peel) {
        const object = repo.objects.get(sha);
        const peeled = object?.type === 'tag' ? /^object ([0-9a-f]{40})/m.exec(object.data.toString())?.[1] : undefined;
        if (peeled) suffix += ` peeled:${peeled}`;
      }
      packets.push(packet(`${sha} ${name}${suffix}\n`));
    }
    const lsResponse = Buffer.concat([...packets, Buffer.from('0000')]);
    if (repoLsCache.size > 64) repoLsCache.clear();
    repoLsCache.set(lsKey, lsResponse);
    return lsResponse;
  }
  const ids = (prefix: string) => lines.filter(l => l.startsWith(prefix)).map(l => l.slice(prefix.length).trim().split(' ')[0]);
  const wants = ids('want '), haves = ids('have '), excluded = new Set<string>();
  const depthLine = lines.find(l => l.startsWith('deepen '));
  const depth = depthLine ? Math.max(1, Number(depthLine.slice(7))) : Infinity;
  const shallow = new Set(ids('shallow ')), boundaries = new Set<string>();
  const walkAll = (id: string) => {
    if (excluded.has(id)) return;
    excluded.add(id); const o = repo.objects.get(id); if (!o) return;
    for (const child of childrenCached(id, o, true)) walkAll(child);
  };
  function children(o: ObjectData, parents: boolean): string[] {
    if (o.type === 'commit') return [...o.data.toString().matchAll(parents ? /^(?:tree|parent) ([0-9a-f]{40})/gm : /^tree ([0-9a-f]{40})/gm)].map(m => m[1]);
    if (o.type === 'tag') return [...o.data.toString().matchAll(/^object ([0-9a-f]{40})/gm)].map(m => m[1]);
    if (o.type !== 'tree') return [];
    const result: string[] = []; let pos = 0;
    while (pos < o.data.length) {
      const zero = o.data.indexOf(0, pos); if (zero < 0 || zero + 21 > o.data.length) break;
      result.push(o.data.subarray(zero + 1, zero + 21).toString('hex')); pos = zero + 21;
    }
    return result;
  }
  // Cache wrapper: same object id + same parents flag always yields the same list.
  function childrenCached(id: string, o: ObjectData, parents: boolean): string[] {
    const cacheKey = id + (parents ? '|p' : '|t');
    const hit = childrenCache.get(cacheKey);
    if (hit) return hit;
    const result = children(o, parents);
    if (childrenCache.size > 8192) childrenCache.clear();
    childrenCache.set(cacheKey, result);
    return result;
  }
  if (!depthLine) for (const id of haves) walkAll(id);
  else for (const id of haves) {
    excluded.add(id);
    const o = repo.objects.get(id); if (o) for (const child of childrenCached(id, o, false)) walkAll(child);
  }
  const selected = new Map<string,ObjectData>(), visited = new Map<string,number>();
  const visit = (id: string, generation: number) => {
    if ((visited.get(id) ?? Infinity) <= generation) return;
    visited.set(id, generation);
    const o = repo.objects.get(id); if (!o) return;
    const stop = o.type === 'commit' && (generation >= depth || (!depthLine && shallow.has(id)));
    if (stop) boundaries.add(id);
    if (!excluded.has(id)) selected.set(id, o);
    if (excluded.has(id) && !depthLine) return;
    if (o.type !== 'commit' && selected.has(id) && excluded.has(id)) return;
    for (const child of childrenCached(id, o, !stop)) visit(child, generation + (o.type === 'commit' && repo.objects.get(child)?.type === 'commit' ? 1 : 0));
  };
  for (const id of wants) visit(id, 1);
  // V1 perf: cache the whole pack response. Key covers every input the pack
  // bytes depend on: protocol version, depth, want/have/shallow lines, and the
  // object count (same count on one repo's timeline = same object set).
  const packKey = [v2 ? '2' : '0', depth === Infinity ? 'inf' : String(depth), wants.join(','), haves.join(','), [...shallow].join(','), repo.objects.size].join('|');
  let repoPackCache = packCache.get(repo);
  if (!repoPackCache) { repoPackCache = new Map(); packCache.set(repo, repoPackCache); }
  const packHit = repoPackCache.get(packKey);
  if (packHit) return packHit;
  const pack = encodePack(selected.values()), packets: Buffer[] = [];
  if (boundaries.size) {
    if (v2) packets.push(packet('shallow-info\n'));
    for (const id of boundaries) packets.push(packet(`shallow ${id}\n`));
    for (const id of shallow) if (!boundaries.has(id)) packets.push(packet(`unshallow ${id}\n`));
    packets.push(Buffer.from(v2 ? '0001' : '0000'));
  }
  if (v2) packets.push(packet('packfile\n'));
  else packets.push(packet('NAK\n'));
  packets.push(sideband(pack));
  const response = Buffer.concat(packets);
  if (repoPackCache.size > 64) repoPackCache.clear();
  repoPackCache.set(packKey, response);
  return response;
}
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const byte = () => { if (pos >= delta.length) throw new Error('Truncated delta'); return delta[pos++]; };
  const integer = () => { let value = 0, scale = 1, c: number; do { c = byte(); value += (c & 127) * scale; scale *= 128; } while (c & 128); return value; };
  const source = integer(), target = integer();
  if (source !== base.length) throw new Error('Delta base size mismatch');
  const chunks: Buffer[] = []; let length = 0;
  while (pos < delta.length) {
    const op = byte();
    if (!op) throw new Error('Invalid delta instruction');
    let chunk: Buffer;
    if (op & 128) {
      let offset = 0, size = 0;
      for (let n = 0; n < 4; n++) if (op & (1 << n)) offset += byte() * 2 ** (8 * n);
      for (let n = 0; n < 3; n++) if (op & (16 << n)) size += byte() * 2 ** (8 * n);
      if (!size) size = 65536;
      if (offset + size > base.length) throw new Error('Delta copy outside base');
      chunk = base.subarray(offset, offset + size);
    } else {
      if (pos + op > delta.length) throw new Error('Truncated delta insert');
      chunk = delta.subarray(pos, pos + op); pos += op;
    }
    length += chunk.length; if (length > target) throw new Error('Delta target overflow'); chunks.push(chunk);
  }
  if (length !== target) throw new Error('Delta target size mismatch');
  return Buffer.concat(chunks);
}
export function decodePack(data: Buffer, existing: Map<string, ObjectData> = new Map()): Map<string, ObjectData> {
  if (data.length < 32 || data.toString('ascii', 0, 4) !== 'PACK') throw new Error('Invalid pack');
  if (![2, 3].includes(data.readUInt32BE(4))) throw new Error('Unsupported pack version');
  const end = data.length - 20;
  if (!createHash('sha1').update(data.subarray(0, end)).digest().equals(data.subarray(end))) throw new Error('Pack checksum mismatch');
  type Entry = { raw: Buffer; baseOffset?: number; baseId?: string; object?: ObjectData };
  const entries: Entry[] = [], positions = new Map<number, Entry>(), output = new Map<string, ObjectData>();
  let pos = 12;
  const byte = () => { if (pos >= end) throw new Error('Truncated pack'); return data[pos++]; };
  for (let n = 0; n < data.readUInt32BE(8); n++) {
    const position = pos; let c = byte(), size = c & 15, scale = 16;
    const type = (c >> 4) & 7;
    while (c & 128) { c = byte(); size += (c & 127) * scale; scale *= 128; }
    let baseOffset: number | undefined, baseId: string | undefined;
    if (type === 6) {
      let b = byte(), distance = b & 127;
      while (b & 128) { b = byte(); distance = (distance + 1) * 128 + (b & 127); }
      baseOffset = position - distance;
    } else if (type === 7) { baseId = data.subarray(pos, pos + 20).toString('hex'); pos += 20; }
    else if (!kinds[type]) throw new Error('Invalid pack type');
    const result = inflateSync(data.subarray(pos, end), { info: true });
    const consumed = (result.engine as any).bytesWritten;
    if (!consumed || result.buffer.length !== size) throw new Error('Invalid object stream');
    pos += consumed;
    const entry: Entry = { raw: result.buffer, baseOffset, baseId };
    entries.push(entry); positions.set(position, entry);
    if (type < 6) { entry.object = { type: kinds[type], data: entry.raw }; output.set(hash(entry.object), entry.object); }
  }
  if (pos !== end) throw new Error('Unexpected pack bytes');
  let unresolved = entries.filter(e => !e.object);
  while (unresolved.length) {
    let progress = false;
    for (const e of unresolved) {
      const base = e.baseOffset !== undefined ? positions.get(e.baseOffset)?.object : output.get(e.baseId!) ?? existing.get(e.baseId!);
      if (!base) continue;
      e.object = { type: base.type, data: applyDelta(base.data, e.raw) };
      output.set(hash(e.object), e.object); progress = true;
    }
    if (!progress) throw new Error('Unresolved delta base');
    unresolved = unresolved.filter(e => !e.object);
  }
  return output;
}
