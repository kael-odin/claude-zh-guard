// 解析转储：异常地址落在哪个模块 + 偏移
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.env.LOCALAPPDATA ?? '', 'Claude-3p', 'Crashpad', 'reports');
const file = process.argv[2] ?? 'c88bc830-89e7-4aab-98e9-24278cda9797.dmp';
const fd = fs.openSync(path.join(dir, file), 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const nStreams = head.readUInt32LE(8);
const dirRva = head.readUInt32LE(12);
let excAddr = 0n;
let modRva = 0;
const entry = Buffer.alloc(12);
for (let i = 0; i < nStreams; i++) {
  fs.readSync(fd, entry, 0, 12, dirRva + i * 12);
  const type = entry.readUInt32LE(0);
  const size = entry.readUInt32LE(4);
  const rva = entry.readUInt32LE(8);
  if (type === 6) {
    const buf = Buffer.alloc(Math.min(size, 32));
    fs.readSync(fd, buf, 0, buf.length, rva);
    excAddr = buf.readBigUInt64LE(24);
  }
  if (type === 7) modRva = rva;
}
if (!modRva) {
  console.log('无模块流');
  process.exit(0);
}
const countBuf = Buffer.alloc(4);
fs.readSync(fd, countBuf, 0, 4, modRva);
const count = countBuf.readUInt32LE(0);
console.log(`模块数 ${count}, 异常地址 ${excAddr.toString(16)}`);
const mod = Buffer.alloc(108);
for (let i = 0; i < count; i++) {
  fs.readSync(fd, mod, 0, 108, modRva + 4 + i * 108);
  const base = mod.readBigUInt64LE(0);
  const size = mod.readUInt32LE(8);
  const nameRva = mod.readUInt32LE(20);
  if (excAddr >= base && excAddr < base + BigInt(size)) {
    const nameLenBuf = Buffer.alloc(4);
    fs.readSync(fd, nameLenBuf, 0, 4, nameRva);
    const nameLen = nameLenBuf.readUInt32LE(0);
    const nameBuf = Buffer.alloc(nameLen);
    fs.readSync(fd, nameBuf, 0, nameLen, nameRva + 4);
    console.log(`命中模块: ${nameBuf.toString('utf16le', 0, Math.floor(nameLen / 2) - 1)}`);
    console.log(`模块基址 ${base.toString(16)} 大小 ${size} → RVA = 0x${(excAddr - base).toString(16)}`);
    break;
  }
}
fs.closeSync(fd);
