// asar 引擎测试：从零构建 / 解析 / 外科式重建 / 损坏检测，并用 @electron/asar 官方库交叉验证
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAsar, parseAsar, readFile, readFileNode, surgicalRebuild, readEmbeddedHeaderHash, getFileNode, listFiles } from '../src/asar.ts';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const ANCHOR = '"en-US","de-DE","fr-FR","ko-KR","ja-JP"';

function fixtureFiles(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  files.set('index.html', Buffer.from('<!doctype html><html><body>hi</body></html>'));
  files.set('assets/v1/index-AbCdEf.js', Buffer.from(`(function(){var L=["en-US","de-DE","fr-FR","ko-KR","ja-JP"];return L})()`));
  files.set('assets/v1/shared-Xy123.js', Buffer.from(`window.W=["en-US","de-DE","fr-FR","ko-KR","ja-JP"];`));
  files.set('i18n/en-US.json', Buffer.from(JSON.stringify({ AbCdEf: 'Hello {name}', Xy: 'World' })));
  files.set('bin/blob.bin', Buffer.alloc(6 * 1024 * 1024, 0x5a)); // 6MB 跨完整性块
  return files;
}

test('从零构建 → 官方库可读、内容一致（integrity 开/关两种）', async (t) => {
  const { extractAll } = await import('@electron/asar');
  for (const integrity of [false, true]) {
    const dir = tmpdir('asar-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const asarPath = path.join(dir, 'test.asar');
    const headerHash = createAsar(asarPath, fixtureFiles(), { integrity });
    const parsed = parseAsar(asarPath);
    assert.equal(listFiles(parsed.tree).length, 5);
    // 官方库解包对比
    const out = path.join(dir, 'out');
    extractAll(asarPath, out);
    const src = fixtureFiles();
    for (const [vpath, data] of src) {
      const got = fs.readFileSync(path.join(out, vpath));
      assert.ok(got.equals(data), `内容不一致: ${vpath}`);
    }
    assert.ok(fs.existsSync(path.join(out, 'i18n', 'en-US.json')));
    // 嵌入哈希函数一致性
    assert.equal(readEmbeddedHeaderHash(asarPath), headerHash);
  }
});

test('外科式重建：追加词典 + 替换 JS，未动文件逐字节一致', async (t) => {
  const dir = tmpdir('asar2-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asarPath = path.join(dir, 'test.asar');
  createAsar(asarPath, fixtureFiles(), { integrity: false });
  const before = parseAsar(asarPath);
  const beforeHtml = readFile(before, 'index.html');
  const beforeBlob = readFile(before, 'bin/blob.bin');
  const oldHash = readEmbeddedHeaderHash(asarPath);

  // 模拟补丁：加 zh-CN 词典 + 替换白名单 JS
  const jsOld = readFile(before, 'assets/v1/shared-Xy123.js');
  const jsNew = Buffer.from(jsOld.toString('utf8').replaceAll(ANCHOR, ANCHOR.slice(0, -1) + ',"zh-CN"'), 'utf8');
  const dict = Buffer.from(JSON.stringify({ AbCdEf: '你好 {name}' }));
  const result = surgicalRebuild(
    asarPath,
    asarPath,
    [
      { vpath: 'i18n/zh-CN.json', data: dict },
      { vpath: 'assets/v1/shared-Xy123.js', data: jsNew },
    ],
  );

  const after = parseAsar(asarPath);
  assert.ok(getFileNode(after, 'i18n/zh-CN.json'), '新文件应存在');
  assert.ok(readFile(after, 'i18n/zh-CN.json').equals(dict));
  assert.ok(readFile(after, 'assets/v1/shared-Xy123.js').equals(jsNew));
  // 未动文件字节一致
  assert.ok(readFile(after, 'index.html').equals(beforeHtml));
  assert.ok(readFile(after, 'bin/blob.bin').equals(beforeBlob));
  // 头部哈希变化且与嵌入函数一致
  assert.notEqual(result.headerHash, oldHash);
  assert.equal(result.headerHash, readEmbeddedHeaderHash(asarPath));
  // 官方库再验证
  const { extractAll } = await import('@electron/asar');
  const out = path.join(dir, 'out2');
  extractAll(asarPath, out);
  assert.ok(fs.readFileSync(path.join(out, 'i18n', 'zh-CN.json')).equals(dict));
});

test('损坏检测：0 字节与截断都要抛错', (t) => {
  const dir = tmpdir('asar3-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asarPath = path.join(dir, 't.asar');
  createAsar(asarPath, new Map([['a.txt', Buffer.from('hello')]]));
  // 0 字节
  fs.writeFileSync(asarPath, Buffer.alloc(0));
  assert.throws(() => parseAsar(asarPath), /过小/);
  // 截断（保留部分头部）
  const buf = Buffer.alloc(32);
  fs.writeFileSync(asarPath, buf);
  assert.throws(() => parseAsar(asarPath), /magic|过小|尺寸异常|读取不完整/);
});

test('偏移重分配正确：替换更大文件后其余文件仍可读', async (t) => {
  const dir = tmpdir('asar4-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asarPath = path.join(dir, 't.asar');
  const files = new Map<string, Buffer>([
    ['a.js', Buffer.from('AAAA')],
    ['b.js', Buffer.from('BBBB')],
    ['c.js', Buffer.from('CCCCCC')],
  ]);
  createAsar(asarPath, files);
  const bigger = Buffer.from('XXXXXXXXXXXXXXXX');
  surgicalRebuild(asarPath, asarPath, [{ vpath: 'a.js', data: bigger }]);
  const parsed = parseAsar(asarPath);
  assert.ok(readFile(parsed, 'a.js').equals(bigger));
  assert.ok(readFile(parsed, 'b.js').equals(files.get('b.js')!));
  assert.ok(readFile(parsed, 'c.js').equals(files.get('c.js')!));
  // readEmbeddedHeaderHash 与 readFileNode 不冲突
  const node = getFileNode(parsed, 'c.js')!;
  assert.ok(readFileNode(parsed, node).equals(files.get('c.js')!));
});
