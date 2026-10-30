// 词典工具：覆盖率检查 / 从上游同步
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectInstall } from './detect.ts';
import { parseAsar, readFile } from './asar.ts';
import { fileExists, info, ok, warn } from './util.ts';

const dictDir = () => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'dict');
const upstreamRepo = 'D:\\Github-Star\\claude-desktop-zh-cn';

/** 词典 vs 安装内 en-US.json 的覆盖率。 */
export function dictCheck(lang: string): void {
  const inst = detectInstall();
  if (!inst) throw new Error('未检测到 Claude Desktop 安装');
  const pa = parseAsar(inst.ionDistPath);
  const enNode = (() => {
    try {
      return readFile(pa, 'i18n/en-US.json');
    } catch {
      return undefined;
    }
  })();
  if (!enNode) throw new Error('asar 内无 i18n/en-US.json（结构异常）');
  const en = JSON.parse(enNode.toString('utf8')) as Record<string, string>;
  const dictPath = path.join(dictDir(), `frontend-${lang}.json`);
  if (!fileExists(dictPath)) throw new Error(`词典缺失: ${dictPath}`);
  const dict = JSON.parse(fs.readFileSync(dictPath, 'utf8')) as Record<string, string>;

  const enKeys = new Set(Object.keys(en));
  let covered = 0;
  let empty = 0;
  for (const k of enKeys) {
    const v = dict[k];
    if (v !== undefined) {
      covered++;
      if (v === '') empty++;
    }
  }
  const stale = Object.keys(dict).filter((k) => !enKeys.has(k)).length;
  const pct = ((covered / enKeys.size) * 100).toFixed(1);
  ok(`en-US 键数: ${enKeys.size}`);
  ok(`词典键数: ${Object.keys(dict).length} (其中新版本已失效: ${stale})`);
  ok(`覆盖率: ${pct}% (翻译 ${covered}${empty ? `，空翻译 ${empty}` : ''})`);
  const missing = enKeys.size - covered;
  if (missing > 0) info(`未覆盖键将自动回退英文显示（不会报错）`);
  if (parseFloat(pct) < 80) warn('覆盖率偏低：该词典可能尚未适配当前 Claude 版本');
}

/** 从本地 javaht 仓库 git pull 并同步词典。 */
export function dictSync(): void {
  if (!fileExists(path.join(upstreamRepo, '.git'))) {
    throw new Error(`上游仓库不存在: ${upstreamRepo}`);
  }
  info(`git -C ${upstreamRepo} pull --ff-only ...`);
  const out = execFileSync('git', ['-C', upstreamRepo, 'pull', '--ff-only'], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  info(out.trim().split(/\r?\n/)[0] ?? '');
  const names = fs.readdirSync(upstreamRepo, 'utf8').filter((f) => /^(frontend|dynamic|statsig|desktop)-zh-(CN|TW|HK)\.json$/.test(f));
  if (names.length === 0) throw new Error('上游仓库未找到词典文件');
  let copied = 0;
  for (const n of names) {
    const src = path.join(upstreamRepo, n);
    const dst = path.join(dictDir(), n);
    if (!fileExists(dst) || fs.readFileSync(src).equals(fs.readFileSync(dst)) === false) {
      fs.copyFileSync(src, dst);
      copied++;
    }
  }
  ok(`词典同步完成，更新 ${copied} 个文件（共 ${names.length} 个）`);
  warn('词典更新后请运行 cdzh install 重打补丁使新词典生效');
}
