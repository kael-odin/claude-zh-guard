// 审计“gated”消息：JS 里有 defaultMessage，但不在 en-US / dynamic 词库中的条目
import fs from 'node:fs';
import { detectInstall } from '../src/detect.ts';
import { getFileNode, listFiles, parseAsar, readFile, readFileNode } from '../src/asar.ts';

const inst = detectInstall()!;
const pa = parseAsar(inst.ionDistPath);
const en = JSON.parse(readFile(pa, 'i18n/en-US.json').toString('utf8')) as Record<string, string>;
const dyn = JSON.parse(readFile(pa, 'i18n/dynamic/en-US.json').toString('utf8')) as Record<string, string>;
const statsig = JSON.parse(fs.readFileSync('assets/dict/statsig-zh-CN.json', 'utf8')) as Record<string, string>;

const js = listFiles(pa.tree).filter((f) => f.startsWith('assets/') && f.endsWith('.js'));
const gated: Array<{ id: string; msg: string; file: string; statsig: boolean }> = [];
const seen = new Set<string>();
for (const f of js) {
  const n = getFileNode(pa, f);
  if (!n || n.size > 25 * 1024 * 1024) continue;
  const t = readFileNode(pa, n).toString('utf8');
  const re = /defaultMessage:"((?:[^"\\]|\\.)*)"/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(t))) {
    const w = t.slice(Math.max(0, mm.index - 400), mm.index + 400);
    const im = /id:"([^"]+)"/.exec(w);
    if (!im) continue;
    const id = im[1]!;
    if (en[id] !== undefined || dyn[id] !== undefined) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    let msg = mm[1]!;
    try {
      msg = JSON.parse(`"${msg}"`) as string;
    } catch {
      /* keep */
    }
    gated.push({ id, msg, file: f, statsig: statsig[id] !== undefined });
  }
}
console.log('gated messages not in en/dynamic:', gated.length);
gated.sort((a, b) => a.msg.length - b.msg.length);
for (const x of gated.slice(0, 160)) {
  console.log(`${x.id}\t${JSON.stringify(x.msg)}\t${x.file}${x.statsig ? ' [statsig]' : ''}`);
}
