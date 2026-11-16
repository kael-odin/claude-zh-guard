// 审计未汉化词条：en-US 有、词典没有的键；尽量从 JS defaultMessage 还原英文原文
import fs from 'node:fs';
import path from 'node:path';
import { detectInstall } from '../src/detect.ts';
import { getFileNode, listFiles, parseAsar, readFile, readFileNode } from '../src/asar.ts';

const inst = detectInstall()!;
const pa = parseAsar(inst.ionDistPath);
const en = JSON.parse(readFile(pa, 'i18n/en-US.json').toString('utf8')) as Record<string, string>;
const dict = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'assets/dict/frontend-zh-CN.json'), 'utf8')) as Record<string, string>;

// 从 JS 中提取 id -> defaultMessage
const idToMsg = new Map<string, { msg: string; file: string }>();
const jsFiles = listFiles(pa.tree).filter((f) => f.startsWith('assets/') && f.endsWith('.js'));
for (const f of jsFiles) {
  const n = getFileNode(pa, f)!;
  if (n.size > 25 * 1024 * 1024) continue;
  const t = readFileNode(pa, n).toString('utf8');
  const re = /defaultMessage:"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const window = t.slice(Math.max(0, m.index - 400), m.index + 400);
    const idm = /id:"([^"]+)"/.exec(window);
    if (!idm) continue;
    let msg = m[1]!;
    try {
      msg = JSON.parse(`"${msg}"`);
    } catch {
      /* 保留原串 */
    }
    if (!idToMsg.has(idm[1]!)) idToMsg.set(idm[1]!, { msg, file: f });
  }
}

const missing = Object.keys(en).filter((k) => dict[k] === undefined);
const withMsg = missing.map((id) => ({
  id,
  msg: idToMsg.get(id)?.msg ?? en[id]!,
  file: idToMsg.get(id)?.file ?? '',
}));
withMsg.sort((a, b) => a.msg.length - b.msg.length);

console.log('en keys', Object.keys(en).length, 'dict keys', Object.keys(dict).length, 'missing', missing.length);
console.log('missing with JS literal', withMsg.filter((x) => x.file).length);
console.log('\n===== 100 shortest missing messages =====');
for (const x of withMsg.slice(0, 100)) {
  console.log(`${x.id}\t${JSON.stringify(x.msg)}\t${x.file}`);
}

console.log('\n===== screenshot strings mapping =====');
const probes = ['Server error', 'Try again', 'Review', 'Audit', 'Board', 'Compact', 'Messages', 'Skills', 'System prompt', 'MCP tools', 'agent time', 'Automated task', 'Customize', 'Search'];
for (const p of probes) {
  const hits = [...idToMsg.entries()].filter(([, v]) => v.msg === p || v.msg.includes(p));
  if (hits.length === 0) {
    console.log(`${p}: no defaultMessage hit`);
    continue;
  }
  console.log(`${p}:`);
  for (const [id, v] of hits.slice(0, 6)) {
    console.log(`  ${id}\t${JSON.stringify(v.msg)}\ttranslated=${dict[id] !== undefined}\t${v.file}`);
  }
}

// 按模块统计缺失
const byFile = new Map<string, number>();
for (const x of withMsg) {
  const f = x.file || '(no-literal)';
  byFile.set(f, (byFile.get(f) ?? 0) + 1);
}
console.log('\n===== missing by module (top 15) =====');
for (const [f, c] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(c, f);
