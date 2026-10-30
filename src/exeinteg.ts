// Claude.exe 内嵌 asar 完整性哈希：定位与改写（64 字节十六进制，原地写）
import fs from 'node:fs';

const MARKER_HEAD = 'resources\\\\';

export interface ExeMarker {
  asar: string;
  hash: string;
  hashOffset: number; // exe 内 64 字节十六进制哈希的起始偏移
}

export function findExeMarkers(exePath: string): ExeMarker[] {
  const fd = fs.openSync(exePath, 'r');
  const results: ExeMarker[] = [];
  try {
    const chunkSize = 16 * 1024 * 1024;
    const overlap = 512;
    const buf = Buffer.alloc(chunkSize + overlap);
    let base = 0;
    while (true) {
      const read = fs.readSync(fd, buf, 0, buf.length, base);
      if (read <= 0) break;
      const text = buf.toString('latin1', 0, read);
      let idx = 0;
      while ((idx = text.indexOf(MARKER_HEAD, idx)) !== -1) {
        const m = /^resources\\\\([\w.-]+\.asar)","alg":"SHA256","value":"([0-9a-f]{64})"/.exec(text.slice(idx, idx + 256));
        if (m) {
          const head = 'resources\\\\' + m[1] + '","alg":"SHA256","value":"';
          results.push({ asar: m[1]!, hash: m[2]!, hashOffset: base + idx + head.length });
        }
        idx += MARKER_HEAD.length;
      }
      if (read < buf.length) break;
      base += read - overlap;
    }
  } finally {
    fs.closeSync(fd);
  }
  return results;
}

/** 原地改写某 asar 的嵌入哈希。返回是否实际改动。 */
export function writeExeMarkerHash(exePath: string, asarName: string, newHashHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(newHashHex)) throw new Error('哈希格式非法');
  const markers = findExeMarkers(exePath);
  const target = markers.find((m) => m.asar === asarName);
  if (!target) throw new Error(`exe 中未找到 ${asarName} 的完整性条目`);
  if (target.hash === newHashHex) return false;
  const fd = fs.openSync(exePath, 'r+');
  try {
    fs.writeSync(fd, Buffer.from(newHashHex, 'latin1'), 0, 64, target.hashOffset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}
