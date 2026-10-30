// asar 引擎：解析 / 读取 / 从零构建 / 外科式重建。
// 格式参考 @electron/asar：8 字节前缀 + Chromium Pickle 包裹的 JSON 头 + 内容区。
import fs from 'node:fs';
import crypto from 'node:crypto';

export const INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024;

export interface Integrity {
  algorithm: 'SHA256';
  hash: string;
  blockSize: number;
  blocks: string[];
}

export interface AsarFileNode {
  size: number;
  offset: string;
  unpacked?: boolean;
  integrity?: Integrity;
}

export interface AsarDirNode {
  files: Record<string, AsarNode>;
}

export type AsarNode = AsarFileNode | AsarDirNode;
export type FileTree = Record<string, AsarNode>;

export interface ParsedAsar {
  path: string;
  tree: FileTree;
  contentBase: number;
  pickleSize: number;
  fileSize: number;
}

export function isDirNode(n: AsarNode): n is AsarDirNode {
  return typeof (n as AsarDirNode).files === 'object';
}

export function sha256hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function computeIntegrity(data: Buffer): Integrity {
  const blocks: string[] = [];
  for (let off = 0; off < data.length; off += INTEGRITY_BLOCK_SIZE) {
    blocks.push(sha256hex(data.subarray(off, Math.min(off + INTEGRITY_BLOCK_SIZE, data.length))));
  }
  return { algorithm: 'SHA256', hash: sha256hex(data), blockSize: INTEGRITY_BLOCK_SIZE, blocks };
}

export function align4(n: number): number {
  return Math.ceil(n / 4) * 4;
}

/**
 * 构建 pickle 头：
 *   [u32 4][u32 pickleSize][u32 payloadSize][u32 strLen][json][零填充对齐]
 * strLen = json 字节数（无 NUL，官方约定如此，已用 @electron/asar 交叉验证）；
 * payloadSize = align4(4 + strLen)；pickleSize = 4 + payloadSize。
 * 返回整段头部字节（长度 8 + pickleSize，即 contentBase）。
 */
export function buildPickleHeader(tree: FileTree): Buffer {
  const json = Buffer.from(JSON.stringify({ files: tree }), 'utf8');
  const strLen = json.length;
  const payloadSize = align4(4 + strLen);
  const pickleSize = 4 + payloadSize;
  const out = Buffer.alloc(8 + pickleSize); // 零填充即对齐
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(pickleSize, 4);
  out.writeUInt32LE(payloadSize, 8);
  out.writeUInt32LE(strLen, 12);
  json.copy(out, 16);
  return out;
}

/**
 * exe 内嵌的 AsarIntegrity 哈希 = sha256(头部 JSON 字符串字节，不含 NUL，即 [16, 16+strLen))。
 * 已在真机 app.asar 上验证（ion-dist 的官方嵌入值为陈旧数据，公式一致处理）。
 */
export function headerPickleHash(headerBuf: Buffer): string {
  const strLen = headerBuf.readUInt32LE(12);
  return sha256hex(headerBuf.subarray(16, 16 + strLen));
}

/** 从树直接计算嵌入哈希（含 files 包装）。注意：树中若有整数型键，
 *  JSON 往返会重排键序，此值可能与磁盘原始字节不一致——校验磁盘文件请用 readEmbeddedHeaderHash。 */
export function treeIntegrityHash(tree: FileTree): string {
  return sha256hex(Buffer.from(JSON.stringify({ files: tree }), 'utf8'));
}

/** 直接从磁盘 asar 文件读取头部 JSON 字节并计算嵌入哈希（字节级精确，不受键序影响）。 */
export function readEmbeddedHeaderHash(asarPath: string): string {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const strLen = head.readUInt32LE(12);
    if (strLen <= 2 || strLen > 256 * 1024 * 1024) throw new Error(`头部尺寸异常: ${asarPath}`);
    const jsonBuf = Buffer.alloc(strLen);
    fs.readSync(fd, jsonBuf, 0, strLen, 16);
    return sha256hex(jsonBuf);
  } finally {
    fs.closeSync(fd);
  }
}

export function parseAsar(p: string): ParsedAsar {
  const st = fs.statSync(p);
  if (st.size < 64) {
    throw new Error(`asar 文件过小(${st.size} 字节)，已损坏或被截断: ${p}`);
  }
  const fd = fs.openSync(p, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.readUInt32LE(0) !== 4) {
      throw new Error(`不是合法 asar（magic=${head.readUInt32LE(0)}），文件可能已损坏: ${p}`);
    }
    const pickleSize = head.readUInt32LE(4);
    const jsonSize = head.readUInt32LE(12);
    if (pickleSize <= 0 || pickleSize > 256 * 1024 * 1024 || jsonSize <= 2 || jsonSize > pickleSize) {
      throw new Error(`asar 头部尺寸异常(pickleSize=${pickleSize}, jsonSize=${jsonSize}): ${p}`);
    }
    const jsonBuf = Buffer.alloc(jsonSize);
    const read = fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    if (read !== jsonSize) throw new Error(`asar 头部读取不完整: ${p}`);
    const root = JSON.parse(jsonBuf.toString('utf8').replace(/\0+$/, '')) as { files?: FileTree };
    const tree: FileTree = root.files ?? (root as unknown as FileTree);
    return { path: p, tree, contentBase: 8 + pickleSize, pickleSize, fileSize: st.size };
  } finally {
    fs.closeSync(fd);
  }
}

/** 按虚拟路径取文件节点，如 "i18n/zh-CN.json"。 */
export function getFileNode(pa: ParsedAsar, vpath: string): AsarFileNode | undefined {
  let cur: AsarNode | undefined = { files: pa.tree };
  for (const part of vpath.split('/')) {
    if (!cur || isDirNode(cur)) {
      cur = cur ? (cur as AsarDirNode).files[part] : undefined;
    } else {
      return undefined;
    }
  }
  if (cur && !isDirNode(cur)) return cur;
  return undefined;
}

/** 列出某虚拟目录下（递归）所有文件路径。 */
export function listFiles(tree: FileTree, dirPrefix = ''): string[] {
  const out: string[] = [];
  const walk = (nodeFiles: Record<string, AsarNode>, prefix: string) => {
    for (const [name, child] of Object.entries(nodeFiles)) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (isDirNode(child)) walk(child.files, p);
      else out.push(p);
    }
  };
  walk(dirPrefix ? (getDirNode(tree, dirPrefix)?.files ?? {}) : tree, dirPrefix);
  return out;
}

function getDirNode(tree: FileTree, vdir: string): AsarDirNode | undefined {
  let cur: AsarNode | undefined = { files: tree };
  for (const part of vdir.split('/')) {
    if (!cur || !isDirNode(cur)) return undefined;
    cur = cur.files[part];
  }
  return cur && isDirNode(cur) ? cur : undefined;
}

export function readFileNode(pa: ParsedAsar, node: AsarFileNode): Buffer {
  if (node.unpacked) throw new Error(`该文件为 unpacked 条目，不在 asar 内: ${node.offset}`);
  const buf = Buffer.alloc(node.size);
  const fd = fs.openSync(pa.path, 'r');
  try {
    const read = fs.readSync(fd, buf, 0, node.size, pa.contentBase + Number(node.offset));
    if (read !== node.size) throw new Error(`读取不完整(期望 ${node.size}，实际 ${read}): ${pa.path}`);
  } finally {
    fs.closeSync(fd);
  }
  return buf;
}

export function readFile(pa: ParsedAsar, vpath: string): Buffer {
  const node = getFileNode(pa, vpath);
  if (!node) throw new Error(`asar 内不存在: ${vpath}`);
  return readFileNode(pa, node);
}

function cloneTree(tree: FileTree): FileTree {
  return JSON.parse(JSON.stringify(tree)) as FileTree;
}

/** 确定性遍历（每层按名称排序），返回 [vpath, node] 且按写入顺序排列。 */
function orderedFiles(tree: FileTree): Array<[string, AsarFileNode]> {
  const out: Array<[string, AsarFileNode]> = [];
  const walk = (files: Record<string, AsarNode>, prefix: string) => {
    for (const name of Object.keys(files).sort()) {
      const child = files[name];
      const p = prefix ? `${prefix}/${name}` : name;
      if (isDirNode(child)) walk(child.files, p);
      else out.push([p, child]);
    }
  };
  walk(tree, '');
  return out;
}

export interface Upsert {
  vpath: string;
  data: Buffer;
}

export interface RebuildResult {
  headerHash: string;
  contentSize: number;
  fileSize: number;
  upserted: string[];
}

export interface RebuildOptions {
  /** integrity 块策略：preserve=跟随源文件（默认）；always=全部补上（javaht 兼容形态）；never=全部去掉 */
  integrity?: 'preserve' | 'always' | 'never';
}

/**
 * 外科式重建：从 srcAsar 流式拷贝未改动文件，仅替换/追加 upsert 中的文件，重写头部。
 * 写到 destPath（同目录临时文件 + 原子改名），随后自校验。
 */
export function surgicalRebuild(srcAsar: string, destAsar: string, upserts: Upsert[], opts?: RebuildOptions): RebuildResult {
  const src = parseAsar(srcAsar);
  const tree = cloneTree(src.tree);
  const mode = opts?.integrity ?? 'preserve';
  const srcHasIntegrity = listFiles(src.tree).some((p) => {
    const n = getFileNode(src, p);
    return n?.integrity !== undefined;
  });
  const emitIntegrity = mode === 'always' ? true : mode === 'never' ? false : srcHasIntegrity;
  const hasUnpacked = listFiles(src.tree).some((p) => getFileNode(src, p)?.unpacked);
  if (hasUnpacked) {
    throw new Error('源 asar 含 unpacked 条目，本工具暂不支持（ion-dist.asar 不应有此类条目）');
  }

  // 先记录全部旧位置（重分配偏移后仍需按旧偏移从源文件流式拷贝）
  const oldLocation = new Map<string, { offset: string; size: number }>();
  for (const [p, node] of orderedFiles(tree)) oldLocation.set(p, { offset: node.offset, size: node.size });

  // 应用 upsert：节点标记 pending 数据
  const pending = new Map<string, Buffer>();
  for (const up of upserts) {
    const parts = up.vpath.split('/');
    let cur: FileTree = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      const next = cur[name];
      if (!next) {
        cur[name] = { files: {} };
      } else if (isDirNode(next)) {
        // ok
      } else {
        throw new Error(`upsert 路径与已有文件冲突: ${up.vpath}`);
      }
      cur = (cur[name] as AsarDirNode).files;
    }
    const leaf = parts[parts.length - 1]!;
    cur[leaf] = { size: up.data.length, offset: '0' };
    pending.set(up.vpath, up.data);
  }

  // 重新分配偏移
  const ordered = orderedFiles(tree);
  let cursor = 0;
  for (const [, node] of ordered) {
    node.offset = String(cursor);
    cursor += node.size;
  }

  // integrity 块：always 模式需在写头前为每个文件算好（未改动文件流式哈希，不整读进内存）
  if (emitIntegrity) {
    const srcFd0 = fs.openSync(srcAsar, 'r');
    try {
      const chunk = Buffer.alloc(4 * 1024 * 1024);
      for (const [vpath, node] of ordered) {
        const pend = pending.get(vpath);
        if (pend) {
          node.integrity = computeIntegrity(pend);
          continue;
        }
        const old = oldLocation.get(vpath)!;
        const h = crypto.createHash('sha256');
        const blocks: string[] = [];
        let blockHash: crypto.Hash | null = null;
        let filePos = 0;
        let remaining = old.size;
        let srcOff = src.contentBase + Number(old.offset);
        while (remaining > 0) {
          const want = Math.min(remaining, chunk.length);
          const read = fs.readSync(srcFd0, chunk, 0, want, srcOff);
          if (read <= 0) throw new Error(`源文件读取提前结束: ${vpath}`);
          h.update(chunk.subarray(0, read));
          let off = 0;
          while (off < read) {
            if (!blockHash) blockHash = crypto.createHash('sha256');
            const blockRemain = INTEGRITY_BLOCK_SIZE - (filePos % INTEGRITY_BLOCK_SIZE);
            const take = Math.min(read - off, blockRemain);
            blockHash.update(chunk.subarray(off, off + take));
            off += take;
            filePos += take;
            if (filePos % INTEGRITY_BLOCK_SIZE === 0 || filePos === old.size) {
              blocks.push(blockHash.digest('hex'));
              blockHash = null;
            }
          }
          srcOff += read;
          remaining -= read;
        }
        node.integrity = { algorithm: 'SHA256', hash: h.digest('hex'), blockSize: INTEGRITY_BLOCK_SIZE, blocks };
      }
    } finally {
      fs.closeSync(srcFd0);
    }
  }

  const header = buildPickleHeader(tree);
  const contentBase = header.length;
  const tmp = `${destAsar}.tmp-${process.pid}-${Date.now()}`;
  const srcFd = fs.openSync(srcAsar, 'r');
  const dstFd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(dstFd, header);
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    for (const [vpath, node] of ordered) {
      const pend = pending.get(vpath);
      if (pend) {
        fs.writeSync(dstFd, pend);
        continue;
      }
      const old = oldLocation.get(vpath);
      if (!old || old.size !== node.size) throw new Error(`内部错误：未改动文件位置缺失或尺寸不一致 ${vpath}`);
      let remaining = old.size;
      let srcOff = src.contentBase + Number(old.offset);
      while (remaining > 0) {
        const want = Math.min(remaining, chunk.length);
        const read = fs.readSync(srcFd, chunk, 0, want, srcOff);
        if (read <= 0) throw new Error(`源文件读取提前结束: ${vpath}`);
        fs.writeSync(dstFd, chunk, 0, read);
        srcOff += read;
        remaining -= read;
      }
    }
    fs.fsyncSync(dstFd);
  } finally {
    fs.closeSync(srcFd);
    fs.closeSync(dstFd);
  }

  // 自校验：重解析 + upsert 内容逐字节复核
  const verify = parseAsar(tmp);
  if (verify.contentBase !== contentBase) throw new Error('自校验失败：contentBase 不一致');
  for (const up of upserts) {
    const node = getFileNode(verify, up.vpath);
    if (!node || node.size !== up.data.length) throw new Error(`自校验失败：${up.vpath}`);
    const got = readFileNode(verify, node);
    if (!got.equals(up.data)) throw new Error(`自校验失败：${up.vpath} 内容不一致`);
  }
  const finalSize = contentBase + cursor;

  fs.renameSync(tmp, destAsar);
  return {
    headerHash: headerPickleHash(header),
    contentSize: cursor,
    fileSize: finalSize,
    upserted: upserts.map((u) => u.vpath),
  };
}

/** 从零构建 asar（测试夹具/小档案用）。返回头部 pickle 的 SHA256。 */
export function createAsar(destAsar: string, files: Map<string, Buffer>, opts?: { integrity?: boolean }): string {
  const tree: FileTree = {};
  const pending = new Map<string, Buffer>();
  for (const [vpath, data] of files) {
    const parts = vpath.split('/');
    let cur: FileTree = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      if (!cur[name]) cur[name] = { files: {} };
      cur = (cur[name] as AsarDirNode).files;
    }
    const leaf = parts[parts.length - 1]!;
    cur[leaf] = { size: data.length, offset: '0', ...(opts?.integrity ? { integrity: computeIntegrity(data) } : {}) };
    pending.set(vpath, data);
  }
  const ordered = orderedFiles(tree);
  let cursor = 0;
  for (const [, node] of ordered) {
    node.offset = String(cursor);
    cursor += node.size;
  }
  const header = buildPickleHeader(tree);
  const tmp = `${destAsar}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, header);
    for (const [vpath] of ordered) {
      fs.writeSync(fd, pending.get(vpath)!);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, destAsar);
  return headerPickleHash(header);
}
