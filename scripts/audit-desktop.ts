// 主进程缺失词条：英文精确匹配现有译文的覆盖率，输出待人工翻译清单
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectInstall } from '../src/detect.ts';
import { getFileNode, parseAsar, readFileNode } from '../src/asar.ts';
import { loadState } from '../src/state.ts';

const inst = detectInstall()!;
const state = loadState();
const backup = state?.backups.find((b) => b.version === inst.version);
const appPath =
  backup && fs.existsSync(path.join(backup.dir, 'app.asar')) ? path.join(backup.dir, 'app.asar') : inst.appAsarPath;
const appPa = parseAsar(appPath);
const en = JSON.parse(readFileNode(appPa, getFileNode(appPa, 'resources/i18n/en-US.json')!).toString('utf8')) as Record<string, string>;
const zhHans = JSON.parse(readFileNode(appPa, getFileNode(appPa, 'resources/i18n/zh-Hans.json')!).toString('utf8')) as Record<string, string>;
const upstream = JSON.parse(fs.readFileSync('assets/dict/desktop-zh-CN.json', 'utf8')) as Record<string, string>;
const extraPath = path.join('assets/dict', 'desktop-extra-zh-CN.json');
const extra = fs.existsSync(extraPath) ? (JSON.parse(fs.readFileSync(extraPath, 'utf8')) as Record<string, string>) : {};

const enToZh = new Map<string, string>();
const add = (k: string, v: string) => {
  if (!k || !v) return;
  if (!enToZh.has(k)) enToZh.set(k, v);
};
for (const [id, text] of Object.entries(en)) {
  if (zhHans[id]) add(text, zhHans[id]!);
  if (upstream[id]) add(text, upstream[id]!);
}
const missing = Object.keys(en).filter((k) => zhHans[k] === undefined && upstream[k] === undefined && extra[k] === undefined);
const resolved: Array<{ id: string; en: string; zh: string }> = [];
const unresolved: Array<{ id: string; en: string }> = [];
for (const id of missing) {
  const text = String(en[id]);
  const zh = enToZh.get(text);
  if (zh) resolved.push({ id, en: text, zh });
  else unresolved.push({ id, en: text });
}
console.log('missing total', missing.length, 'auto-resolved', resolved.length, 'unresolved', unresolved.length);
console.log('\n===== auto-resolved =====');
for (const r of resolved) console.log(`${r.id}\t${JSON.stringify(r.en)}\t${JSON.stringify(r.zh)}`);
console.log('\n===== unresolved =====');
for (const r of unresolved) console.log(`${r.id}\t${JSON.stringify(r.en)}`);
fs.writeFileSync(path.join(os.tmpdir(), 'desktop-missing.json'), JSON.stringify({ resolved, unresolved }, null, 2));
