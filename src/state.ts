// 工具状态（journal）：记录补丁前后的关键哈希与备份位置，支持事务回滚
import fs from 'node:fs';
import path from 'node:path';
import { toolDataDir } from './detect.ts';
import { fileExists } from './util.ts';

export interface BackupInfo {
  version: string;
  dir: string;
  ionDistSha256: string;
  ionDistHeaderHash: string;
  exeSha256: string;
  exeMarkers: Array<{ asar: string; hash: string }>; // 打补丁前 exe 内嵌值
  createdAt: string;
}

export interface GuardState {
  toolVersion: string;
  kind: string;
  installRoot: string;
  resourcesDir: string;
  exePath: string;
  claudeVersion: string;
  lang: string;
  packageFamily?: string;
  patchedAt: string;
  ionDistPatchedHeaderHash: string;
  ionDistPatchedSha256: string;
  appAsarHeaderHash: string;
  backups: BackupInfo[];
  pending?: string; // 事务中间态标记
}

const statePath = () => path.join(toolDataDir(), 'state.json');

export function loadState(): GuardState | undefined {
  const p = statePath();
  if (!fileExists(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as GuardState;
  } catch {
    return undefined;
  }
}

export function saveState(s: GuardState): void {
  const dir = toolDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = statePath();
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

export function clearState(): void {
  const p = statePath();
  if (fileExists(p)) fs.unlinkSync(p);
}

export function backupDirFor(version: string): string {
  return path.join(toolDataDir(), 'backups', version);
}
