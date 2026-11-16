// 统计 gated 消息能被现有词库/上游硬编码表“精确英文匹配”覆盖多少
import fs from 'node:fs';
import path from 'node:path';
import { detectInstall, toolDataDir } from '../src/detect.ts';
import { getFileNode, listFiles, parseAsar, readFile, readFileNode } from '../src/asar.ts';
import { loadState } from '../src/state.ts';

const inst = detectInstall()!;
const state = loadState();
const backup = state?.backups.find((b) => b.version === inst.version);
const pristineIon =
  backup && fs.existsSync(path.join(backup.dir, 'ion-dist.asar'))
    ? path.join(backup.dir, 'ion-dist.asar')
    : inst.ionDistPath;
const pa = parseAsar(pristineIon);
const en = JSON.parse(readFile(pa, 'i18n/en-US.json').toString('utf8')) as Record<string, string>;
const dict = JSON.parse(fs.readFileSync('assets/dict/frontend-zh-CN.json', 'utf8')) as Record<string, string>;
const upstreamDir = process.env.CDZH_UPSTREAM_DIR ?? path.join(toolDataDir(), 'upstream', 'claude-desktop-zh-cn');
const hardPath = path.join(upstreamDir, 'resources', 'frontend-hardcoded-zh-CN.json');
const hard = fs.existsSync(hardPath)
  ? (JSON.parse(fs.readFileSync(hardPath, 'utf8')) as Array<[string, string]>)
  : [];

// 英文原文 -> 中文
const enToZh = new Map<string, string>();
for (const [id, text] of Object.entries(en)) {
  const zh = dict[id];
  if (typeof text === 'string' && zh && text.trim()) enToZh.set(text, zh);
}
for (const [rawEn, zh] of hard) {
  let key = rawEn;
  if (key.startsWith('"') && key.endsWith('"')) {
    try {
      key = JSON.parse(key) as string;
    } catch {
      /* keep */
    }
  }
  if (!enToZh.has(key)) enToZh.set(key, zh);
}

const js = listFiles(pa.tree).filter((f) => f.startsWith('assets/') && f.endsWith('.js'));
const gated = new Map<string, string>();
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
    if (en[id] !== undefined) continue;
    let msg = mm[1]!;
    try {
      msg = JSON.parse(`"${msg}"`) as string;
    } catch {
      /* keep */
    }
    gated.set(id, msg);
  }
}

const covered: Array<{ id: string; msg: string; zh: string }> = [];
const uncovered: Array<{ id: string; msg: string }> = [];
for (const [id, msg] of gated) {
  const zh = enToZh.get(msg);
  if (zh) covered.push({ id, msg, zh });
  else uncovered.push({ id, msg });
}
console.log('gated unique ids:', gated.size);
console.log('covered by exact English match:', covered.length, `(${((covered.length / gated.size) * 100).toFixed(1)}%)`);
console.log('uncovered:', uncovered.length);
console.log('\n===== uncovered (shortest 120) =====');
uncovered.sort((a, b) => a.msg.length - b.msg.length);
for (const x of uncovered.slice(0, 120)) console.log(`${x.id}\t${JSON.stringify(x.msg)}`);
console.log('\n===== covered samples =====');
for (const x of covered.slice(0, 30)) console.log(`${x.id}\t${JSON.stringify(x.msg)} -> ${JSON.stringify(x.zh)}`);
