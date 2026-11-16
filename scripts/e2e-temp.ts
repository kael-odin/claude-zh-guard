// 端到端副本验证：对当前安装的 ion-dist.asar / app.asar 做与 install 相同的重建，
// 全程只写临时目录，不修改真实安装。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectInstall } from '../src/detect.ts';
import { loadState } from '../src/state.ts';
import { getFileNode, listFiles, parseAsar, readFile, readFileNode, surgicalRebuild, type Upsert } from '../src/asar.ts';
import {
  analyzeWhitelist,
  buildGatedContext,
  catalogLooksChinese,
  collectGatedCatalog,
  mergeLocaleOverride,
  patchDefaultMessages,
  patchLanguageWhitelist,
  patchLocaleDisplayNames,
} from '../src/patch.ts';

const inst = detectInstall();
if (!inst) throw new Error('no install');
const lang = 'zh-CN';
const dictDir = path.join(process.cwd(), 'assets', 'dict');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdzh-e2e-'));
console.log('temp:', tmpRoot);

// 优先用本工具的纯净备份做源，确保测试的是“从官方纯净态打补丁”的完整流程
const state = loadState();
const backup = state?.backups?.find((b) => b.version === inst.version);
const ionSrc = backup && fs.existsSync(path.join(backup.dir, 'ion-dist.asar')) ? path.join(backup.dir, 'ion-dist.asar') : inst.ionDistPath;
const appSrc = backup && fs.existsSync(path.join(backup.dir, 'app.asar')) ? path.join(backup.dir, 'app.asar') : inst.appAsarPath;
console.log('source:', backup ? `backup v${inst.version}（纯净）` : '当前安装（可能已打补丁）');
const workIon = path.join(tmpRoot, 'ion-dist.asar');
const workApp = path.join(tmpRoot, 'app.asar');
fs.copyFileSync(ionSrc, workIon);
fs.copyFileSync(appSrc, workApp);

// ---- ion-dist ----
const ionPa = parseAsar(workIon);
const frontend = fs.readFileSync(path.join(dictDir, `frontend-${lang}.json`));
const upserts: Upsert[] = [
  { vpath: `i18n/dynamic/${lang}.json`, data: fs.readFileSync(path.join(dictDir, `dynamic-${lang}.json`)) },
  { vpath: `i18n/statsig/${lang}.json`, data: fs.readFileSync(path.join(dictDir, `statsig-${lang}.json`)) },
];
const enData = readFile(ionPa, 'i18n/en-US.json');
const gatedCtx = buildGatedContext(enData, readFile(ionPa, 'i18n/dynamic/en-US.json'), frontend, lang);
const ionJsFiles = listFiles(ionPa.tree).filter((p) => p.startsWith('assets/') && p.endsWith('.js'));
let catalogAdded = 0;
for (const f of ionJsFiles) {
  const node = getFileNode(ionPa, f);
  if (!node) continue;
  catalogAdded += collectGatedCatalog(readFileNode(ionPa, node), gatedCtx);
}
const dictObj = JSON.parse(frontend.toString('utf8')) as Record<string, string>;
for (const [id, zh] of gatedCtx.gatedCatalog) if (dictObj[id] === undefined) dictObj[id] = zh;
const frontendAug = Buffer.from(JSON.stringify(dictObj), 'utf8');
upserts.push({ vpath: `i18n/${lang}.json`, data: frontendAug });
const merged = mergeLocaleOverride(enData, frontendAug);
upserts.push({ vpath: 'i18n/en-US.json', data: merged.data });
let anchors = 0;
let gatedHits = 0;
for (const f of ionJsFiles) {
  const node = getFileNode(ionPa, f);
  if (!node) continue;
  let data = readFileNode(ionPa, node);
  let changed = false;
  const [w, hits] = patchLanguageWhitelist(data, lang);
  if (hits) {
    data = w;
    changed = true;
    anchors += hits;
  }
  const [n, nh] = patchLocaleDisplayNames(data, lang);
  if (nh) {
    data = n;
    changed = true;
  }
  const [g, gh] = patchDefaultMessages(data, gatedCtx);
  if (gh) {
    data = g;
    changed = true;
    gatedHits += gh;
  }
  if (changed) upserts.push({ vpath: f, data });
}
console.log(
  'ion upserts:',
  upserts.length,
  'whitelist arrays:',
  anchors,
  'gated catalog:',
  catalogAdded,
  'defaultMessage localized:',
  gatedHits,
  'en-US overrides:',
  merged.changed,
);
const ionRes = surgicalRebuild(workIon, workIon, upserts, { integrity: 'always' });
console.log('ion rebuilt:', (ionRes.fileSize / 1048576).toFixed(1) + 'MB', ionRes.headerHash.slice(0, 12));

// ---- app.asar ----
const appPa = parseAsar(workApp);
const unpackedBefore = listFiles(appPa.tree).filter((p) => getFileNode(appPa, p)?.unpacked);
const appEn = getFileNode(appPa, 'resources/i18n/en-US.json')!;
const desktopBase = fs.readFileSync(path.join(dictDir, `desktop-${lang}.json`));
const officialName = lang === 'zh-CN' ? 'zh-Hans' : 'zh-Hant';
const officialNode = getFileNode(appPa, `resources/i18n/${officialName}.json`);
let desktop = officialNode
  ? mergeLocaleOverride(readFileNode(appPa, officialNode), desktopBase).data
  : desktopBase;
const extraDesktopPath = path.join(dictDir, `desktop-extra-${lang}.json`);
if (fs.existsSync(extraDesktopPath)) {
  const obj = JSON.parse(desktop.toString('utf8')) as Record<string, string>;
  const extra = JSON.parse(fs.readFileSync(extraDesktopPath, 'utf8')) as Record<string, string>;
  Object.assign(obj, extra);
  desktop = Buffer.from(JSON.stringify(obj), 'utf8');
}
const appMerged = mergeLocaleOverride(readFileNode(appPa, appEn), desktop);
const appUpserts: Upsert[] = [
  { vpath: 'resources/i18n/en-US.json', data: appMerged.data },
  { vpath: `resources/i18n/${lang}.json`, data: desktop },
];
const appRes = surgicalRebuild(workApp, workApp, appUpserts, { integrity: 'always' });
console.log('app rebuilt:', (appRes.fileSize / 1048576).toFixed(1) + 'MB', appRes.headerHash.slice(0, 12), 'desktop overrides:', appMerged.changed);

// ---- verify ----
const check = (label: string, cond: boolean, extra = '') => {
  console.log(cond ? 'PASS' : 'FAIL', label, extra);
  if (!cond) process.exitCode = 1;
};
const ion2 = parseAsar(workIon);
const app2 = parseAsar(workApp);
check('ion zh dict exists', !!getFileNode(ion2, `i18n/${lang}.json`));
check('ion en-US merged', catalogLooksChinese(readFile(ion2, 'i18n/en-US.json')));
check('ion dynamic zh exists', !!getFileNode(ion2, `i18n/dynamic/${lang}.json`));
let allHave = true;
let total = 0;
for (const f of listFiles(ion2.tree).filter((p) => p.startsWith('assets/') && p.endsWith('.js'))) {
  const node = getFileNode(ion2, f)!;
  const { hits, hasLang } = analyzeWhitelist(readFileNode(ion2, node).toString('utf8'), lang);
  if (hits > 0) {
    total += hits;
    if (!hasLang) allHave = false;
  }
}
check('ion all whitelist arrays contain lang', allHave, `arrays=${total}`);
const nameMapPatched = listFiles(ion2.tree)
  .filter((f) => f.startsWith('assets/') && f.endsWith('.js'))
  .some((f) => {
    const n = getFileNode(ion2, f)!;
    return n.size < 8000 && readFileNode(ion2, n).toString('utf8').includes('"zh-CN":{');
  });
check('ion name map has zh-CN', nameMapPatched);
check('ion gated messages translated', gatedHits > 1000, `count=${gatedHits}`);
let gatedCancelOk = false;
for (const f of listFiles(ion2.tree).filter((p) => p.startsWith('assets/') && p.endsWith('.js'))) {
  const t = readFile(ion2, f).toString('utf8');
  if (t.includes('defaultMessage:"取消",id:"47FYwba+bI"')) {
    gatedCancelOk = true;
    break;
  }
}
check('ion gated Cancel becomes 取消', gatedCancelOk);
const ionFiles = listFiles(ion2.tree);
let maxEnd = 0;
let integ = 0;
for (const f of ionFiles) {
  const n = getFileNode(ion2, f)!;
  maxEnd = Math.max(maxEnd, Number(n.offset) + n.size);
  if (n.integrity) integ++;
}
check('ion offsets closed', ion2.contentBase + maxEnd === ion2.fileSize);
check('ion integrity all', integ === ionFiles.length, `${integ}/${ionFiles.length}`);

const appFiles = listFiles(app2.tree);
const unpackedAfter = appFiles.filter((p) => getFileNode(app2, p)?.unpacked);
check('app unpacked count preserved', unpackedAfter.length === unpackedBefore.length, `${unpackedAfter.length}`);
check(
  'app unpacked no offset',
  unpackedAfter.every((p) => {
    const n = getFileNode(app2, p)!;
    return n.offset === undefined;
  }),
);
check('app desktop en-US merged', catalogLooksChinese(readFile(app2, 'resources/i18n/en-US.json')));
check('app zh desktop exists', !!getFileNode(app2, `resources/i18n/${lang}.json`));
let appMaxEnd = 0;
let appInteg = 0;
for (const f of appFiles) {
  const n = getFileNode(app2, f)!;
  if (n.unpacked) continue;
  appMaxEnd = Math.max(appMaxEnd, Number(n.offset) + n.size);
  if (n.integrity) appInteg++;
}
check('app offsets closed', app2.contentBase + appMaxEnd === app2.fileSize);
check('app packed integrity all', appInteg === appFiles.length - unpackedAfter.length, `${appInteg}/${appFiles.length - unpackedAfter.length}`);
const origInteg = getFileNode(appPa, unpackedBefore[0]!)!.integrity!.hash;
const newInteg = getFileNode(app2, unpackedBefore[0]!)!.integrity!.hash;
check('app unpacked integrity preserved', origInteg === newInteg);

// ---- exe 内嵌哈希同步（副本）----
const workExe = path.join(tmpRoot, 'Claude.exe');
fs.copyFileSync(inst.exePath, workExe);
const { findExeMarkers, writeExeMarkerHash } = await import('../src/exeinteg.ts');
const { readEmbeddedHeaderHash } = await import('../src/asar.ts');
const ionHash = readEmbeddedHeaderHash(workIon);
const appHash = readEmbeddedHeaderHash(workApp);
const beforeMarkers = findExeMarkers(workExe);
check('exe has ion-dist + app markers', beforeMarkers.length >= 2, beforeMarkers.map((m) => m.asar).join(','));
writeExeMarkerHash(workExe, 'ion-dist.asar', ionHash);
writeExeMarkerHash(workExe, 'app.asar', appHash);
const afterMarkers = findExeMarkers(workExe);
check('exe ion-dist hash synced', afterMarkers.find((m) => m.asar === 'ion-dist.asar')?.hash === ionHash);
check('exe app.asar hash synced', afterMarkers.find((m) => m.asar === 'app.asar')?.hash === appHash);

console.log('\nwork files kept at', tmpRoot);
