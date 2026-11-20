// 列出指定 asar 中“看起来像用户文案”的未翻译键（默认当前安装，可用 CDZH_SOURCE_ION 指定）
import fs from 'node:fs';
import { detectInstall } from '../src/detect.ts';
import { getFileNode, listFiles, parseAsar, readFile, readFileNode } from '../src/asar.ts';
import { buildGatedContext } from '../src/patch.ts';

const inst = detectInstall()!;
const source = process.env.CDZH_SOURCE_ION ?? inst.ionDistPath;
const pa = parseAsar(source);
const enData = readFile(pa, 'i18n/en-US.json');
const en = JSON.parse(enData.toString('utf8')) as Record<string, string>;
const dictRaw = fs.readFileSync('assets/dict/frontend-zh-CN.json');
const dict = JSON.parse(dictRaw.toString('utf8')) as Record<string, string>;
const dynNode = getFileNode(pa, 'i18n/dynamic/en-US.json');
const ctx = buildGatedContext(enData, dynNode ? readFileNode(pa, dynNode) : undefined, dictRaw, 'zh-CN');

const idToMsg = new Map<string, { msg: string; file: string }>();
for (const f of listFiles(pa.tree).filter((x) => x.startsWith('assets/') && x.endsWith('.js'))) {
  const n = getFileNode(pa, f);
  if (!n || n.size > 25 * 1024 * 1024) continue;
  const t = readFileNode(pa, n).toString('utf8');
  for (const mm of t.matchAll(/defaultMessage:"((?:[^"\\]|\\.)*)"/g)) {
    const w = t.slice(Math.max(0, mm.index - 300), mm.index + 300);
    const im = /id:"([^"]+)"/.exec(w);
    if (!im || idToMsg.has(im[1]!)) continue;
    let msg = mm[1]!;
    try {
      msg = JSON.parse(`"${msg}"`) as string;
    } catch {
      /* keep */
    }
    idToMsg.set(im[1]!, { msg, file: f });
  }
}

const missing = Object.keys(en).filter((k) => dict[k] === undefined);
const rows = missing.map((k) => ({
  k,
  msg: idToMsg.get(k)?.msg ?? en[k]!,
  has: !!idToMsg.get(k),
  file: idToMsg.get(k)?.file ?? '',
}));
const visible = rows.filter(
  (r) =>
    r.has &&
    typeof r.msg === 'string' &&
    r.msg.length >= 4 &&
    r.msg.length <= 90 &&
    /[A-Za-z]/.test(r.msg) &&
    !/^[A-Z0-9 _\-/.:+]+$/.test(r.msg) &&
    !/https?:|\/\/|\b[a-z_]+\.[a-z]{2,4}\b/i.test(r.msg),
);
console.log('source', source);
console.log('missing', missing.length, 'with JS literal', rows.filter((r) => r.has).length, 'visible-ish', visible.length);
const covered = visible.filter((r) => ctx.englishToZh.has(r.msg));
const uncovered = visible.filter((r) => !ctx.englishToZh.has(r.msg));
console.log('visible covered by defaultMessage map', covered.length, 'uncovered', uncovered.length);
console.log('--- uncovered visible ---');
uncovered.sort((a, b) => a.msg.length - b.msg.length);
for (const r of uncovered.slice(0, 120)) console.log(`${r.k}\t${JSON.stringify(r.msg)}\t${r.file}`);
