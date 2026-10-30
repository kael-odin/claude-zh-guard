// 探测脚本：在纯净安装上验证 exe 内嵌 asar 哈希的计算公式，并确认原头部是否带 per-file integrity。
// 用法: node scripts/probe.ts [resourcesDir]
import fs from 'node:fs';
import { parseAsar, headerPickleHash, sha256hex, getFileNode } from '../src/asar.ts';

const resDir = process.argv[2] ?? 'C:/Program Files/WindowsApps/Claude_4.29.0.0_x64__pzs8sxrjxfjjc/app/resources';
const exePath = `${resDir}/../Claude.exe`;

function findMarkers(exe: string): Array<{ asar: string; hash: string; offset: number }> {
  const markerHead = 'resources\\\\';
  const results: Array<{ asar: string; hash: string; offset: number }> = [];
  const fd = fs.openSync(exe, 'r');
  try {
    const chunkSize = 16 * 1024 * 1024;
    const overlap = 512;
    let base = 0;
    const buf = Buffer.alloc(chunkSize + overlap);
    while (true) {
      const read = fs.readSync(fd, buf, 0, buf.length, base);
      if (read <= 0) break;
      const text = buf.toString('latin1', 0, read);
      let idx = 0;
      while ((idx = text.indexOf(markerHead, idx)) !== -1) {
        const m = /^resources\\\\([\w.-]+\.asar)","alg":"SHA256","value":"([0-9a-f]{64})"/.exec(text.slice(idx, idx + 256));
        if (m) results.push({ asar: m[1]!, hash: m[2]!, offset: base + idx });
        idx += 16;
      }
      base += read - overlap;
      if (read < buf.length) break;
    }
  } finally {
    fs.closeSync(fd);
  }
  return results;
}

const markers = findMarkers(exePath);
console.log(`exe 内嵌 asar 条目 ${markers.length} 个:`);
for (const m of markers) console.log(`  ${m.asar} -> ${m.hash} (exe偏移 ${m.offset})`);

for (const asarName of ['ion-dist.asar', 'app.asar']) {
  const p = `${resDir}/${asarName}`;
  if (!fs.existsSync(p)) continue;
  const pa = parseAsar(p);
  const fd = fs.openSync(p, 'r');
  const pickle = Buffer.alloc(pa.pickleSize);
  fs.readSync(fd, pickle, 0, pa.pickleSize, 8);
  fs.closeSync(fd);
  const candidates: Record<string, string> = {
    'sha256(pickle bytes [8..8+pickleSize))': sha256hex(pickle),
    'sha256(header [0..contentBase))': sha256hex(Buffer.concat([Buffer.from([4, 0, 0, 0]), pickle]).subarray(0, pa.contentBase)),
  };
  const actual = sha256hex(fs.readFileSync(p)); // 仅小文件可承受；ion-dist 191MB 也还行
  const embedded = markers.find((m) => m.asar === asarName);
  console.log(`\n${asarName}:`);
  console.log(`  文件大小=${pa.fileSize} pickleSize=${pa.pickleSize} contentBase=${pa.contentBase}`);
  for (const [k, v] of Object.entries(candidates)) {
    console.log(`  ${v === embedded?.hash ? '✓ 匹配' : '  '} ${k} = ${v}`);
  }
  console.log(`  ${actual === embedded?.hash ? '✓ 匹配' : '  '} sha256(整个文件) = ${actual}`);
  console.log(`  exe 内嵌值 = ${embedded?.hash ?? '(未找到)'}`);
  // per-file integrity 是否存在
  const sample = getFileNode(pa, 'i18n/en-US.json');
  console.log(`  i18n/en-US.json integrity 存在: ${sample?.integrity ? '是 (' + sample.integrity.blocks.length + ' blocks)' : '否'}`);
  const idx = getFileNode(pa, 'index.html');
  console.log(`  index.html integrity 存在: ${idx?.integrity ? '是' : '否'}`);
}
