// 补丁核心：install / uninstall / restore，事务化，失败即回滚
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getFileNode,
  listFiles,
  parseAsar,
  readFile,
  readFileNode,
  readEmbeddedHeaderHash,
  sha256hex,
  surgicalRebuild,
  type Upsert,
} from './asar.ts';
import { detectInstall, existingConfigPaths, type ClaudeInstall } from './detect.ts';
import { findExeMarkers, writeExeMarkerHash } from './exeinteg.ts';
import { backupDirFor, clearState, loadState, saveState, type BackupInfo, type GuardState } from './state.ts';
import { fail, fileExists, info, listClaudePids, log, ok, run, startDetached, stopClaudeProcesses, warn } from './util.ts';

export const LANGS = ['zh-CN', 'zh-TW', 'zh-HK'] as const;
export type Lang = (typeof LANGS)[number];

const TOOL_VERSION = '0.4.1';

// Claude 4.23118 起语言白名单扩为 11 种语言；更早版本只有前 5 种。
// 统一按“以 en-US..ja-JP 开头的数组”识别，追加语言到数组末尾（幂等）。
const WHITELIST_ARRAY_RE = /\["en-US","de-DE","fr-FR","ko-KR","ja-JP"(?:,"[\w-]+")*\]/g;

const LOCALE_LABELS: Record<Lang, { name: string; localName: string }> = {
  'zh-CN': { name: 'Chinese (Simplified)', localName: '中文（简体）' },
  'zh-TW': { name: 'Chinese (Traditional)', localName: '中文（繁體）' },
  'zh-HK': { name: 'Chinese (Traditional, Hong Kong)', localName: '中文（繁體，香港）' },
};

const dictDir = () => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'dict');

function loadDict(name: string): Buffer {
  const p = path.join(dictDir(), name);
  if (!fileExists(p)) throw new Error(`词典缺失: ${p}`);
  return fs.readFileSync(p);
}

/** 按 id 覆盖词库（用于人工补充的桌面/system 词条）。 */
function applyDictOverlay(data: Buffer, name: string): Buffer {
  const p = path.join(dictDir(), name);
  if (!fileExists(p)) return data;
  try {
    const base = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
    const extra = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    for (const [id, zh] of Object.entries(extra)) if (typeof zh === 'string') base[id] = zh;
    return Buffer.from(JSON.stringify(base), 'utf8');
  } catch {
    return data;
  }
}

/** 语言白名单锚点替换：以 5 语言前缀识别任意长度的官方列表，追加语言到末尾（幂等）。 */
export function patchLanguageWhitelist(js: Buffer, lang: string): [Buffer, number] {
  const text = js.toString('utf8');
  let count = 0;
  const out = text.replace(WHITELIST_ARRAY_RE, (match) => {
    if (match.includes(`"${lang}"`)) return match;
    count++;
    return `${match.slice(0, -1)},"${lang}"]`;
  });
  return [Buffer.from(out, 'utf8'), count];
}

/** 统计 JS 中语言白名单数组数量，以及是否已含目标语言。 */
export function analyzeWhitelist(text: string, lang: string): { hits: number; hasLang: boolean } {
  let hits = 0;
  let hasLang = false;
  for (const m of text.matchAll(WHITELIST_ARRAY_RE)) {
    hits++;
    if (m[0].includes(`"${lang}"`)) hasLang = true;
  }
  return { hits, hasLang };
}

/** 语言选择器名称表：把中文条目补进官方 11 语言名称映射（幂等）。 */
export function patchLocaleDisplayNames(js: Buffer, lang: Lang): [Buffer, number] {
  const text = js.toString('utf8');
  const anchor = '"en-US":{name:"English (United States)",localName:"English (United States)"}';
  if (!text.includes(anchor)) return [js, 0];
  if (text.includes(`"${lang}":{name:`)) return [js, 0];
  const label = LOCALE_LABELS[lang];
  const entry = `"${lang}":${JSON.stringify(label)},`;
  return [Buffer.from(text.replace(anchor, entry + anchor), 'utf8'), 1];
}

/**
 * 把中文词库合并进官方 en-US 词库。
 * Claude 4.29+ 前端/主进程固定按 en-US 加载（渲染进程约 1 秒后还会把 locale 写回 en-US），
 * 只放 <lang>.json 不会被选中；覆盖 en-US 才能让仅存在于词库的条目显示中文，
 * 新版本新增而词典未覆盖的键保留英文。
 */
export function mergeLocaleOverride(target: Buffer, override: Buffer): { data: Buffer; changed: number } {
  const t = JSON.parse(target.toString('utf8')) as Record<string, unknown>;
  const o = JSON.parse(override.toString('utf8')) as Record<string, unknown>;
  let changed = 0;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== 'string') continue;
    if (t[k] !== v) {
      t[k] = v;
      changed++;
    }
  }
  return { data: Buffer.from(JSON.stringify(t), 'utf8'), changed };
}

/**
 * gated / 兜底消息本地化上下文。
 * Claude 5.x 的“gated imports”会带一批不在本地 en-US/dynamic 词库里的消息，
 * 只存在于 JS 的 defaultMessage 中；没有服务端词库时只能显示英文。
 * 这里用现有词典、上游硬编码表与人工补充表做精确英文匹配：
 *  - patchDefaultMessages 直接把 defaultMessage 兜底文案换成中文；
 *  - collectGatedCatalog 收集“id + defaultMessage 相邻”的 gated 词条，补进词库，
 *    覆盖只写 id、不写 defaultMessage 的调用点。
 */
export interface GatedContext {
  enIds: Set<string>;
  dynamicIds: Set<string>;
  englishToZh: Map<string, string>;
  gatedCatalog: Map<string, string>;
}

function decodeJsString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function stripOuterQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      /* keep */
    }
  }
  return s;
}

export function buildGatedContext(
  enJson: Buffer,
  dynamicJson: Buffer | undefined,
  frontendDict: Buffer,
  lang: Lang,
): GatedContext {
  const en = JSON.parse(enJson.toString('utf8')) as Record<string, string>;
  const dynamic = dynamicJson
    ? (JSON.parse(dynamicJson.toString('utf8')) as Record<string, string>)
    : {};
  const dict = JSON.parse(frontendDict.toString('utf8')) as Record<string, string>;
  const englishToZh = new Map<string, string>();
  const ambiguous = new Set<string>();
  const put = (english: string, zh: string, authoritative = false) => {
    if (!english || !zh) return;
    if (authoritative) {
      englishToZh.set(english, zh);
      ambiguous.delete(english);
      return;
    }
    if (ambiguous.has(english)) return;
    const prev = englishToZh.get(english);
    if (prev === undefined) englishToZh.set(english, zh);
    else if (prev !== zh) {
      // 同一英文在不同上下文有不同译法：默认不自动替换，避免张冠李戴
      ambiguous.add(english);
      englishToZh.delete(english);
    }
  };
  for (const [id, text] of Object.entries(en)) {
    if (typeof text === 'string' && text.trim() && dict[id]) put(text, dict[id]!);
  }
  // 上游硬编码表只用于“精确英文匹配”，不做通用字符串替换
  const hardPath = path.join(dictDir(), `hardcoded-${lang}.json`);
  if (fileExists(hardPath)) {
    try {
      const list = JSON.parse(fs.readFileSync(hardPath, 'utf8')) as Array<[string, string]>;
      for (const [rawEn, rawZh] of list) put(stripOuterQuotes(String(rawEn)), stripOuterQuotes(String(rawZh)));
    } catch {
      /* 硬编码表损坏则跳过 */
    }
  }
  // 人工补充表：英文原文 -> 中文（英文优先于自动表，便于修正上下文）
  const extraPath = path.join(dictDir(), `extra-${lang}.json`);
  if (fileExists(extraPath)) {
    try {
      const obj = JSON.parse(fs.readFileSync(extraPath, 'utf8')) as Record<string, string>;
      for (const [english, zh] of Object.entries(obj)) put(english, zh, true);
    } catch {
      /* 忽略 */
    }
  }
  return {
    enIds: new Set(Object.keys(en)),
    dynamicIds: new Set(Object.keys(dynamic)),
    englishToZh,
    gatedCatalog: new Map<string, string>(),
  };
}

/** 收集 gated 词条：id 与 defaultMessage 在同一对象内相邻时，登记 id -> 中文。 */
export function collectGatedCatalog(js: Buffer, ctx: GatedContext): number {
  const text = js.toString('utf8');
  if (!text.includes('defaultMessage:') || !text.includes('id:')) return 0;
  let added = 0;
  const add = (id: string, rawMsg: string) => {
    if (ctx.enIds.has(id) || ctx.dynamicIds.has(id) || ctx.gatedCatalog.has(id)) return;
    const zh = ctx.englishToZh.get(decodeJsString(rawMsg));
    if (zh) {
      ctx.gatedCatalog.set(id, zh);
      added++;
    }
  };
  for (const m of text.matchAll(/defaultMessage:"((?:[^"\\]|\\.)*)",id:"([^"]+)"/g)) add(m[2]!, m[1]!);
  for (const m of text.matchAll(/id:"([^"]+)",defaultMessage:"((?:[^"\\]|\\.)*)"/g)) add(m[1]!, m[2]!);
  return added;
}

/** ICU 占位符安全校验：英文有占位符时，中文必须保留同一组参数且花括号平衡。 */
function safeIcuReplacement(english: string, zh: string): boolean {
  const open = (english.match(/\{/g) ?? []).length;
  const close = (english.match(/\}/g) ?? []).length;
  if (open !== close) return false;
  const zhOpen = (zh.match(/\{/g) ?? []).length;
  const zhClose = (zh.match(/\}/g) ?? []).length;
  if (zhOpen !== zhClose) return false;
  if (open === 0) return zhOpen === 0;
  const args = (s: string) =>
    new Set([...s.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!));
  const enArgs = args(english);
  const zhArgs = args(zh);
  if (enArgs.size === 0) return zhArgs.size === 0;
  for (const a of enArgs) if (!zhArgs.has(a)) return false;
  for (const a of zhArgs) if (!enArgs.has(a)) return false;
  return true;
}

/** 把 defaultMessage 兜底文案换成中文；只按精确英文匹配，不改 id。 */
export function patchDefaultMessages(js: Buffer, ctx: GatedContext): [Buffer, number] {
  const text = js.toString('utf8');
  if (!text.includes('defaultMessage:')) return [js, 0];
  let count = 0;
  const out = text.replace(/defaultMessage:"((?:[^"\\]|\\.)*)"/g, (match, raw: string) => {
    const msg = decodeJsString(raw);
    const zh = ctx.englishToZh.get(msg);
    if (!zh || zh === msg || !safeIcuReplacement(msg, zh)) return match;
    count++;
    return `defaultMessage:${JSON.stringify(zh)}`;
  });
  return [Buffer.from(out, 'utf8'), count];
}

export interface IonDistStatus {
  parseable: boolean;
  error?: string;
  size: number;
  zhInHeader: boolean;
  anchorHasLang: boolean;
  anchorHits: number;
  enUsMerged: boolean;
  headerHash?: string;
  fileSha256?: string;
}

/** en-US 词库是否已被中文覆盖（抽样检查 CJK 占比）。 */
export function catalogLooksChinese(data: Buffer): boolean {
  try {
    const obj = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
    const values = Object.values(obj).filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, 300);
    if (values.length === 0) return false;
    const cjk = values.filter((v) => /[\u4e00-\u9fff]/.test(v)).length;
    return cjk / values.length > 0.5;
  } catch {
    return false;
  }
}

/** 评估 ion-dist.asar 当前状态（找到锚点文件后即早停，不必扫全部 js）。 */
export function assessIonDist(install: ClaudeInstall, lang: string): IonDistStatus {
  const st: IonDistStatus = {
    parseable: false,
    size: 0,
    zhInHeader: false,
    anchorHasLang: false,
    anchorHits: 0,
    enUsMerged: false,
  };
  if (!fileExists(install.ionDistPath)) {
    st.error = '文件不存在';
    return st;
  }
  st.size = fs.statSync(install.ionDistPath).size;
  if (st.size === 0) {
    st.error = '文件为 0 字节（典型的官方更新损坏）';
    return st;
  }
  let pa;
  try {
    pa = parseAsar(install.ionDistPath);
  } catch (e) {
    st.error = `头部解析失败: ${(e as Error).message}`;
    return st;
  }
  st.parseable = true;
  st.zhInHeader = !!getFileNode(pa, `i18n/${lang}.json`);
  try {
    st.headerHash = readEmbeddedHeaderHash(install.ionDistPath);
    st.fileSha256 = sha256hex(fs.readFileSync(install.ionDistPath));
  } catch {
    /* 忽略 */
  }
  const enNode = getFileNode(pa, 'i18n/en-US.json');
  if (enNode && enNode.size < 32 * 1024 * 1024) st.enUsMerged = catalogLooksChinese(readFileNode(pa, enNode));
  const files = listAllFiles(pa.tree).filter((f) => f.startsWith('assets/') && f.endsWith('.js'));
  for (const f of files) {
    const node = getFileNode(pa, f);
    if (!node || node.size > 25 * 1024 * 1024) continue;
    const { hits, hasLang } = analyzeWhitelist(readFileNode(pa, node).toString('utf8'), lang);
    st.anchorHasLang = st.anchorHasLang || hasLang;
    st.anchorHits += hits;
    if (st.anchorHits > 0 && st.anchorHasLang) break;
  }
  return st;
}

function listAllFiles(tree: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (files: Record<string, unknown>, prefix: string) => {
    for (const [name, child] of Object.entries(files)) {
      const p = prefix ? `${prefix}/${name}` : name;
      const c = child as { files?: Record<string, unknown> };
      if (c && typeof c.files === 'object') walk(c.files, p);
      else out.push(p);
    }
  };
  walk(tree, '');
  return out;
}


function sha256File(p: string): string {
  return sha256hex(fs.readFileSync(p));
}

/** 确保目录可写（必要时走 takeown + icacls；需管理员权限）。 */
function ensureWritable(dir: string): void {
  const probe = (): boolean => {
    try {
      const p = path.join(dir, `.cdzh-probe-${process.pid}`);
      fs.writeFileSync(p, 'x');
      fs.unlinkSync(p);
      return true;
    } catch {
      return false;
    }
  };
  if (probe()) return;

  const user = process.env.USERNAME ?? 'Users';
  log(`目录不可写，尝试取得所有权并授权 (${user}) ...`);
  // 商店版目录属 TrustedInstaller，管理员也需先 takeown 才能改 ACL
  try {
    run('takeown', ['/F', dir, '/R', '/D', 'Y'], { timeoutMs: 300_000, quiet: true });
  } catch {
    /* 非提权或已拥有所有权，继续尝试 icacls */
  }
  try {
    run('icacls', [dir, '/grant', `${user}:(OI)(CI)F`, '/T'], { timeoutMs: 300_000, quiet: true });
  } catch {
    /* 下面统一探测 */
  }
  if (!probe()) {
    throw new Error('无写入权限且授权失败：请以管理员身份运行（或 cdzh --elevate install）');
  }
}

/** 确保单个文件可写（Claude.exe 可能与目录权限不一致）。 */
function ensureFileWritable(file: string): void {
  try {
    const fd = fs.openSync(file, 'r+');
    fs.closeSync(fd);
    return;
  } catch {
    /* 继续授权 */
  }
  const user = process.env.USERNAME ?? 'Users';
  try {
    run('takeown', ['/F', file], { quiet: true });
  } catch {
    /* ignore */
  }
  try {
    run('icacls', [file, '/grant', `${user}:F`], { quiet: true });
  } catch {
    /* ignore */
  }
  try {
    const fd = fs.openSync(file, 'r+');
    fs.closeSync(fd);
  } catch {
    throw new Error(`无写入权限: ${file}（请以管理员身份运行）`);
  }
}

/** 备份 ion-dist.asar、app.asar 与 Claude.exe 到包外目录（按版本，幂等）。 */
export function makeBackup(install: ClaudeInstall, reuseExisting = true): BackupInfo {
  const dir = backupDirFor(install.version);
  const metaPath = path.join(dir, 'backup.json');
  const appBackupPath = path.join(dir, 'app.asar');
  const hasAppAsar = fileExists(install.appAsarPath);

  if (
    reuseExisting &&
    fileExists(path.join(dir, 'ion-dist.asar')) &&
    fileExists(path.join(dir, 'Claude.exe')) &&
    fileExists(metaPath)
  ) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as BackupInfo;
    // 旧版本备份没有 app.asar；新引擎会改写主进程包，必须补一份纯净备份
    if (hasAppAsar && (!meta.appAsarSha256 || !fileExists(appBackupPath))) {
      info('补齐 app.asar 纯净备份（旧备份格式升级）...');
      fs.copyFileSync(install.appAsarPath, appBackupPath);
      meta.appAsarSha256 = sha256File(appBackupPath);
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    }
    ok(`复用已有纯净备份: ${dir}`);
    return meta;
  }
  fs.mkdirSync(dir, { recursive: true });
  info(`备份 ion-dist.asar、app.asar 与 Claude.exe → ${dir} ...`);
  fs.copyFileSync(install.ionDistPath, path.join(dir, 'ion-dist.asar'));
  if (hasAppAsar) fs.copyFileSync(install.appAsarPath, appBackupPath);
  fs.copyFileSync(install.exePath, path.join(dir, 'Claude.exe'));
  const meta: BackupInfo = {
    version: install.version,
    dir,
    ionDistSha256: sha256File(path.join(dir, 'ion-dist.asar')),
    ionDistHeaderHash: readEmbeddedHeaderHash(path.join(dir, 'ion-dist.asar')),
    exeSha256: sha256File(path.join(dir, 'Claude.exe')),
    exeMarkers: findExeMarkers(path.join(dir, 'Claude.exe')).map((m) => ({ asar: m.asar, hash: m.hash })),
    ...(hasAppAsar ? { appAsarSha256: sha256File(appBackupPath) } : {}),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  ok('备份完成');
  return meta;
}

/** 从备份恢复 ion-dist.asar / app.asar 并还原 exe 内嵌哈希（哈希全部从磁盘字节重算）。 */
export function restorePristine(install: ClaudeInstall, backup: BackupInfo): void {
  if (sha256File(path.join(backup.dir, 'ion-dist.asar')) !== backup.ionDistSha256) {
    throw new Error('备份文件校验失败，拒绝恢复');
  }
  info('恢复 ion-dist.asar ← 纯净备份 ...');
  fs.copyFileSync(path.join(backup.dir, 'ion-dist.asar'), install.ionDistPath);

  const appBackup = path.join(backup.dir, 'app.asar');
  if (backup.appAsarSha256) {
    if (!fileExists(appBackup)) throw new Error('备份缺少 app.asar，无法安全恢复主进程包');
    if (sha256File(appBackup) !== backup.appAsarSha256) throw new Error('app.asar 备份校验失败，拒绝恢复');
    info('恢复 app.asar ← 纯净备份 ...');
    fs.copyFileSync(appBackup, install.appAsarPath);
  } else if (fileExists(appBackup)) {
    info('恢复 app.asar ← 旧格式备份 ...');
    fs.copyFileSync(appBackup, install.appAsarPath);
  }

  info('还原 exe 内嵌哈希 ...');
  const ionHash = readEmbeddedHeaderHash(install.ionDistPath);
  const appHash = fileExists(install.appAsarPath) ? readEmbeddedHeaderHash(install.appAsarPath) : undefined;
  for (const m of backup.exeMarkers) {
    const hash = m.asar === 'ion-dist.asar' ? ionHash : m.asar === 'app.asar' ? (appHash ?? m.hash) : m.hash;
    if (writeExeMarkerHash(install.exePath, m.asar, hash)) info(`  已还原 ${m.asar} → ${hash.slice(0, 12)}...`);
  }
  ok('纯净状态恢复完成');
}

export interface InstallOptions {
  lang: Lang;
  yes?: boolean;
  launch?: boolean;
}

/** 安装/重装补丁（幂等：已装则先恢复纯净再重打）。 */
export async function install(opts: InstallOptions): Promise<void> {
  const inst = detectInstall();
  if (!inst) throw new Error('未检测到 Claude Desktop 安装');
  const lang = opts.lang;
  log(`目标: ${inst.kind} v${inst.version}  ${inst.resourcesDir}`);
  log(`语言: ${lang}`);

  const state = loadState();

  // ion-dist 健康检查（0 字节 / 头损坏 → 自动修复）
  let status = assessIonDist(inst, lang);
  if (!status.parseable) {
    fail(`ion-dist.asar 异常: ${status.error}`);
    const backup = state?.backups?.find((b) => b.version === inst.version);
    if (backup) {
      info(`发现 v${inst.version} 纯净备份，执行自动修复 ...`);
      restorePristine(inst, backup);
      status = assessIonDist(inst, lang);
    } else {
      throw new Error('无匹配版本备份可修复。请运行 cdzh update 走受控更新，或重装 Claude。');
    }
  }

  // 进程检查（必须先停进程：运行中的 Claude.exe 会锁住自身文件）
  if (listClaudePids().length > 0) {
    if (opts.yes) {
      await stopClaudeProcesses();
      ok('已关闭 Claude 相关进程');
    } else {
      throw new Error('Claude 正在运行，请先退出，或加 --yes 自动关闭');
    }
  }

  // 进程退出后再拿写入权限，避免 exe 被占用导致 EPERM
  ensureWritable(inst.appDir);
  ensureFileWritable(inst.exePath);

  // 外来补丁残留（javaht 的桌面词典文件）。本工具自己写的 <lang>.json 不归档。
  const foreignDict = path.join(inst.resourcesDir, `${lang}.json`);
  const ownDictHint = state?.patchedAt && state.lang === lang;
  if (fileExists(foreignDict) && !ownDictHint) {
    const archiveDir = backupDirFor('foreign');
    fs.mkdirSync(archiveDir, { recursive: true });
    const dest = path.join(archiveDir, `${lang}.json.${Date.now()}`);
    fs.renameSync(foreignDict, dest);
    warn(`检测到其他汉化工具残留 (resources/${lang}.json)，已归档: ${dest}`);
  }

  // 既有补丁 → 先恢复纯净
  if (status.zhInHeader || status.anchorHasLang || status.enUsMerged) {
    const backup = state?.backups?.find((b) => b.version === inst.version);
    if (backup) {
      info('检测到既有补丁，先恢复纯净状态 ...');
      restorePristine(inst, backup);
      status = assessIonDist(inst, lang);
    } else {
      throw new Error('检测到既有补丁但无本工具备份（可能来自其他汉化工具）。请先用原工具卸载后再运行本工具。');
    }
  }

  // 备份（此时应为纯净态）：ion-dist.asar + app.asar + Claude.exe
  const backup = makeBackup(inst);

  // 构造 ion-dist upserts：先全部准备并通过锚点检查，再动包（未动包前的失败 = 零影响）
  const frontendDictRaw = loadDict(`frontend-${lang}.json`);
  const upserts: Upsert[] = [
    { vpath: `i18n/dynamic/${lang}.json`, data: loadDict(`dynamic-${lang}.json`) },
    { vpath: `i18n/statsig/${lang}.json`, data: loadDict(`statsig-${lang}.json`) },
  ];
  let anchorCount = 0;
  let nameMapHit = 0;
  let enOverrideChanged = 0;
  let gatedCount = 0;
  let gatedCatalogAdded = 0;
  {
    const pa = parseAsar(inst.ionDistPath);
    // 4.29+ 前端固定按 en-US 加载词库，必须把中文覆盖进 en-US（未覆盖键保留英文）
    const enNode = getFileNode(pa, 'i18n/en-US.json');
    if (!enNode) throw new Error('asar 内无 i18n/en-US.json（结构异常），补丁中止（未做任何修改）');
    const enData = readFileNode(pa, enNode);
    const dynNode = getFileNode(pa, 'i18n/dynamic/en-US.json');
    const gatedCtx = buildGatedContext(
      enData,
      dynNode ? readFileNode(pa, dynNode) : undefined,
      frontendDictRaw,
      lang,
    );
    const files = listAllFiles(pa.tree).filter((f) => f.startsWith('assets/') && f.endsWith('.js'));

    // 第一遍：收集 id 与 defaultMessage 相邻的 gated 词条，补进词库
    // （有些调用点只写 id，不写 defaultMessage，必须靠词库命中）
    for (const f of files) {
      const node = getFileNode(pa, f);
      if (!node || node.size > 25 * 1024 * 1024) continue;
      gatedCatalogAdded += collectGatedCatalog(readFileNode(pa, node), gatedCtx);
    }
    const dictObj = JSON.parse(frontendDictRaw.toString('utf8')) as Record<string, string>;
    for (const [id, zh] of gatedCtx.gatedCatalog) {
      if (dictObj[id] === undefined) dictObj[id] = zh;
    }
    const frontendDict = Buffer.from(JSON.stringify(dictObj), 'utf8');
    upserts.push({ vpath: `i18n/${lang}.json`, data: frontendDict });

    const merged = mergeLocaleOverride(enData, frontendDict);
    if (merged.changed > 0) {
      upserts.push({ vpath: 'i18n/en-US.json', data: merged.data });
      enOverrideChanged = merged.changed;
    }

    // 第二遍：白名单 / 语言名称 / defaultMessage 兜底文案
    for (const f of files) {
      const node = getFileNode(pa, f);
      if (!node || node.size > 25 * 1024 * 1024) continue;
      let data = readFileNode(pa, node);
      let changed = false;
      const [whitelisted, hits] = patchLanguageWhitelist(data, lang);
      if (hits > 0) {
        data = whitelisted;
        changed = true;
        anchorCount += hits;
      }
      const [named, nameHits] = patchLocaleDisplayNames(data, lang);
      if (nameHits > 0) {
        data = named;
        changed = true;
        nameMapHit += nameHits;
      }
      const [localized, localHits] = patchDefaultMessages(data, gatedCtx);
      if (localHits > 0) {
        data = localized;
        changed = true;
        gatedCount += localHits;
      }
      if (changed) upserts.push({ vpath: f, data });
    }
  }
  if (anchorCount === 0) {
    throw new Error('未找到语言白名单锚点——此版本界面结构可能已变化，补丁中止（未做任何修改）。请反馈此版本号。');
  }
  info(
    `白名单 ${anchorCount} 处 + 名称表 ${nameMapHit} 处 + en-US 词库覆盖 ${enOverrideChanged} 条 + gated 词条 ${gatedCatalogAdded} 条 + defaultMessage 本地化 ${gatedCount} 处，开始重建 ion-dist.asar ...`,
  );

  // 主进程壳层词库：Claude 4.23118+ 从 app.asar 内的 resources/i18n 读取
  const appUpserts: Upsert[] = [];
  let appMergeChanged = 0;
  {
    const pa = parseAsar(inst.appAsarPath);
    const enNode = getFileNode(pa, 'resources/i18n/en-US.json');
    if (enNode) {
      // 主进程官方已带 zh-Hans/zh-Hant（约 864 键），先作为底稿，再用上游桌面词库覆盖；
      // 两套合并后覆盖率明显高于任一单独词库。
      const officialName = lang === 'zh-CN' ? 'zh-Hans' : 'zh-Hant';
      const officialNode = getFileNode(pa, `resources/i18n/${officialName}.json`);
      const upstream = loadDict(`desktop-${lang}.json`);
      const baseDict = officialNode
        ? mergeLocaleOverride(readFileNode(pa, officialNode), upstream).data
        : upstream;
      const desktopDict = applyDictOverlay(baseDict, `desktop-extra-${lang}.json`);
      const merged = mergeLocaleOverride(readFileNode(pa, enNode), desktopDict);
      appUpserts.push({ vpath: 'resources/i18n/en-US.json', data: merged.data });
      appUpserts.push({ vpath: `resources/i18n/${lang}.json`, data: desktopDict });
      appMergeChanged = merged.changed;
    }
  }

  // 事务：pending 标记 → 重建 → exe 哈希 → 收尾
  const base: GuardState =
    state ?? {
      toolVersion: TOOL_VERSION,
      kind: inst.kind,
      installRoot: inst.installRoot,
      resourcesDir: inst.resourcesDir,
      exePath: inst.exePath,
      claudeVersion: inst.version,
      lang,
      patchedAt: '',
      ionDistPatchedHeaderHash: '',
      ionDistPatchedSha256: '',
      appAsarHeaderHash: '',
      backups: [],
    };
  const draft: GuardState = {
    ...base,
    pending: 'ion-dist-rebuild',
    toolVersion: TOOL_VERSION,
    lang,
    claudeVersion: inst.version,
    resourcesDir: inst.resourcesDir,
    exePath: inst.exePath,
    installRoot: inst.installRoot,
    kind: inst.kind,
    packageFamily: inst.packageFamily,
    backups: mergeBackups(base.backups, backup),
  };
  saveState(draft);

  try {
    // integrity 块必须补全：Claude 4.29+ 的运行时校验依赖每个文件带 integrity（javaht 形态已验证可启动）
    const result = surgicalRebuild(inst.ionDistPath, inst.ionDistPath, upserts, { integrity: 'always' });
    info(`ion-dist 重建完成: 文件 ${(result.fileSize / 1048576).toFixed(1)}MB（原 ${(status.size / 1048576).toFixed(1)}MB），新头部哈希 ${result.headerHash.slice(0, 12)}...`);

    draft.ionDistPatchedHeaderHash = result.headerHash;
    draft.ionDistPatchedSha256 = sha256File(inst.ionDistPath);
    saveState(draft);

    const changedIon = writeExeMarkerHash(inst.exePath, 'ion-dist.asar', result.headerHash);

    // 主进程 app.asar：就地重建（保留 unpacked 元数据），并同步 exe 内嵌哈希
    let changedApp = false;
    if (appUpserts.length > 0) {
      draft.pending = 'app-asar-rebuild';
      saveState(draft);
      const appResult = surgicalRebuild(inst.appAsarPath, inst.appAsarPath, appUpserts, { integrity: 'always' });
      draft.appAsarHeaderHash = appResult.headerHash;
      draft.pending = 'exe-hash';
      saveState(draft);
      const appMarker = findExeMarkers(inst.exePath).find((m) => m.asar === 'app.asar');
      if (!appMarker) throw new Error('exe 中未找到 app.asar 完整性条目，无法同步主进程包哈希');
      changedApp = writeExeMarkerHash(inst.exePath, 'app.asar', appResult.headerHash);
      info(`app.asar 重建完成: 桌面词库覆盖 ${appMergeChanged} 条，新头部哈希 ${appResult.headerHash.slice(0, 12)}...`);
    } else {
      draft.appAsarHeaderHash = readEmbeddedHeaderHash(inst.appAsarPath);
      const appMarker = findExeMarkers(inst.exePath).find((m) => m.asar === 'app.asar');
      if (appMarker && appMarker.hash !== draft.appAsarHeaderHash) {
        writeExeMarkerHash(inst.exePath, 'app.asar', draft.appAsarHeaderHash);
        changedApp = true;
      }
    }
    info(`exe 哈希同步: ion-dist ${changedIon ? '已改写' : '一致'}, app.asar ${changedApp ? '已改写' : '一致'}`);

    // 桌面外壳词典（旧版本主进程 / 兼容保留）
    fs.copyFileSync(path.join(dictDir(), `desktop-${lang}.json`), path.join(inst.resourcesDir, `${lang}.json`));

    // config locale
    const configs = existingConfigPaths(inst.packageFamily);
    for (const cfgPath of configs) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
        cfg['locale'] = lang;
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4), 'utf8');
        info(`locale → ${lang}: ${cfgPath}`);
      } catch (e) {
        warn(`config 写入失败 ${cfgPath}: ${(e as Error).message}`);
      }
    }
    if (configs.length === 0) warn('未找到任何 config.json，界面语言请稍后在应用设置里确认');
  } catch (e) {
    // 回滚
    fail(`安装失败: ${(e as Error).message}，正在回滚 ...`);
    try {
      restorePristine(inst, backup);
    } catch (e2) {
      fail(`回滚也失败: ${(e2 as Error).message}。请手动从 ${backup.dir} 恢复。`);
      throw e2;
    }
    throw e;
  }

  delete draft.pending;
  draft.patchedAt = new Date().toISOString();
  saveState(draft);
  ok(`补丁安装完成 (v${inst.version}, ${lang})`);

  if (opts.launch) launch(inst);
}

function mergeBackups(existing: BackupInfo[] | undefined, add: BackupInfo): BackupInfo[] {
  const list = [...(existing ?? [])];
  const i = list.findIndex((b) => b.version === add.version);
  if (i >= 0) list[i] = add;
  else list.push(add);
  return list;
}

/** 卸载：恢复官方纯净状态。 */
export function uninstall(): void {
  const inst = detectInstall();
  if (!inst) throw new Error('未检测到 Claude Desktop 安装');
  const state = loadState();
  if (!state) {
    warn('本工具无安装记录。若装过 javaht 汉化，请用其自带卸载流程。');
    return;
  }
  if (state.pending) warn(`检测到未完成的事务(${state.pending})，将直接恢复纯净状态`);
  const backup = state.backups?.find((b) => b.version === inst.version);
  if (!backup) throw new Error(`没有 v${inst.version} 的备份，无法安全卸载`);
  restorePristine(inst, backup);

  const ours = path.join(inst.resourcesDir, `${state.lang}.json`);
  if (fileExists(ours)) fs.unlinkSync(ours);

  for (const cfgPath of existingConfigPaths(inst.packageFamily)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      cfg['locale'] = 'en-US';
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4), 'utf8');
    } catch {
      /* 忽略 */
    }
  }
  clearState();
  ok('已卸载补丁，恢复官方纯净状态');
}

/** MSIX 激活启动 Claude。 */
export function launch(inst: ClaudeInstall): void {
  if (inst.kind === 'msix' && inst.aumid) {
    // 实测：Start-Process 直接传 shell: 偶发失败；交给 explorer.exe 激活稳定
    startDetached('explorer.exe', [`shell:AppsFolder\\${inst.aumid}`]);
    // 新版可能启动后缩到托盘：等窗口出现后恢复并置前
    const showScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'show-claude-window.ps1');
    if (fileExists(showScript)) {
      startDetached('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', showScript]);
    }
    ok(`已通过 MSIX 激活启动 (${inst.aumid})`);
  } else {
    startDetached(inst.exePath, []);
    ok('已启动 Claude');
  }
}
