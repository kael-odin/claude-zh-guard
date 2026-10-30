// 通用工具：日志、进程执行、字节格式化
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

export const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
export const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
export const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
export const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;

export const log = (...a: unknown[]) => console.log(...a);
export const ok = (s: string) => log(GREEN('✓'), s);
export const warn = (s: string) => log(YELLOW('!'), s);
export const fail = (s: string) => log(RED('✗'), s);
export const info = (s: string) => log(DIM('·'), s);

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** 同步执行命令，失败抛错并带 stderr。 */
export function run(cmd: string, args: string[], opts?: { timeoutMs?: number; quiet?: boolean }): string {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: opts?.timeoutMs ?? 30_000,
      windowsHide: true,
      stdio: opts?.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
    }) as unknown as string;
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf8') ?? '';
    throw new Error(`${cmd} ${args.join(' ')} 失败: ${stderr.trim() || err.message}`);
  }
}

/** 异步启动进程（不等待）。 */
export function startDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
  child.unref();
}

export function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 关闭 Claude 相关进程：托盘应用会无视优雅关闭，直接按镜像名强杀并多轮验证。 */
export async function stopClaudeProcesses(graceMs = 10000): Promise<string[]> {
  const killed: string[] = [];
  for (let round = 0; round < 3; round++) {
    const open = listClaudePids();
    if (open.length === 0) break;
    // 按镜像名树杀（覆盖全部实例与其子进程）；cowork-svc 为提权服务，可能拒绝，忽略
    try {
      run('taskkill', ['/IM', 'claude.exe', '/T', '/F'], { quiet: true });
    } catch {
      /* 逐 PID 兜底 */
      for (const p of open) {
        if (/claude\.exe/i.test(p.name)) {
          try {
            run('taskkill', ['/PID', String(p.pid), '/T', '/F'], { quiet: true });
          } catch {
            /* 已退出 */
          }
        }
      }
    }
    killed.push(...open.map((p) => String(p.pid)));
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (listClaudePids().length === 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (listClaudePids().length > 0) {
    // 给文件句柄释放留点时间
    await new Promise((r) => setTimeout(r, 2000));
  }
  return killed;
}

export function listClaudePids(): Array<{ pid: number; name: string }> {
  try {
    const out = run('tasklist', ['/FO', 'CSV', '/NH'], { quiet: true });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^"?(claude|cowork-svc)\.exe/i.test(l))
      .map((l) => {
        const cells = l.split('","');
        const name = (cells[0] ?? '').replace(/^"/, '');
        const pid = Number((cells[1] ?? '0').replace(/"/g, ''));
        return { pid, name };
      })
      .filter((x) => x.pid > 0);
  } catch {
    return [];
  }
}

/** 全局互斥锁：防止本工具多实例同时写包。用 %LOCALAPPDATA% 锁文件 + PID 探活实现。 */
export class LockFile {
  private path: string;
  constructor(path: string) {
    this.path = path;
  }
  acquire(): boolean {
    if (fileExists(this.path)) {
      try {
        const oldPid = Number(fs.readFileSync(this.path, 'utf8').trim());
        if (oldPid > 0 && isPidAlive(oldPid)) return false;
        fs.unlinkSync(this.path); // 陈旧锁
      } catch {
        return false;
      }
    }
    fs.writeFileSync(this.path, String(process.pid));
    return true;
  }
  release(): void {
    try {
      const pid = Number(fs.readFileSync(this.path, 'utf8').trim());
      if (pid === process.pid) fs.unlinkSync(this.path);
    } catch {
      /* 忽略 */
    }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
