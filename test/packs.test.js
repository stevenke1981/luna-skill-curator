import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readPack, writePack, zipPack } from '../src/packs.js';

const REAL_PACK = 'E:/install_skills/storage-skills-pack-v1.0.zip';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-packs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Builds a zip by hand so tests can express what zipPack never writes: stored entries, comments,
// zip64 markers and bad CRCs.
function rawZip(entries, { comment = Buffer.alloc(0), marker = null } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data);
    const method = e.method ?? 8;
    const packed = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = (zlib.crc32(data) + (e.badCrc ? 1 : 0)) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);

    parts.push(local, name, packed);
    central.push(dir, name);
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = marker === 'count' ? 0xffff : entries.length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(marker === 'offset' ? 0xffffffff : offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, cd, eocd, comment]);
}

const byPath = (files) => new Map(files.map((f) => [f.path, f.data]));

test('zipPack then readPack round-trips files byte for byte', (t) => {
  const dir = tempDir(t);
  const binary = Buffer.from([0, 1, 2, 255, 254, 0x50, 0x4b, 0x05, 0x06, 0x50, 0x4b, 0x03, 0x04, 0]);
  const big = Buffer.alloc(300_000, 'skill text\n');
  const files = [
    { path: 'storage-skills/SKILL.md', data: Buffer.from('---\nname: storage\n---\n\n# 儲存\n') },
    { path: 'storage-skills/中文/說明文件.md', data: Buffer.from('中文檔名\r\n第二行\n') },
    { path: 'storage-skills/assets/blob.bin', data: binary },
    { path: 'storage-skills/empty.txt', data: Buffer.alloc(0) },
    { path: 'storage-skills/big.md', data: big },
  ];
  const file = path.join(dir, 'storage-skills.zip');
  zipPack(file, files);

  const pack = readPack(file);
  assert.equal(pack.name, 'storage-skills');
  assert.deepEqual(pack.files.map((f) => f.path), files.map((f) => f.path));
  const got = byPath(pack.files);
  for (const f of files) {
    assert.ok(Buffer.isBuffer(got.get(f.path)), `${f.path} is a Buffer`);
    assert.ok(got.get(f.path).equals(f.data), `${f.path} is byte-identical`);
  }
});

test('readPack reads a stored (method 0) entry', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'stored.zip');
  fs.writeFileSync(file, rawZip([
    { name: 'pack/SKILL.md', data: 'stored text', method: 0 },
    { name: 'pack/deflated.md', data: 'deflated text' },
  ]));
  const pack = readPack(file);
  const got = byPath(pack.files);
  assert.equal(got.get('pack/SKILL.md').toString('utf8'), 'stored text');
  assert.equal(got.get('pack/deflated.md').toString('utf8'), 'deflated text');
});

test('readPack finds the end record when the comment holds the signature bytes', (t) => {
  const dir = tempDir(t);
  const entries = [{ name: 'pack/SKILL.md', data: 'with comment' }];
  // A comment that contains PK\x05\x06 in the middle, and one that ends with it followed by
  // zeros, which looks like a record ending exactly at the end of the file.
  const tricky = Buffer.concat([
    Buffer.from('before PK\x05\x06 after\n', 'latin1'),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18),
  ]);
  const longest = Buffer.alloc(0xffff);
  for (let i = 0; i < longest.length; i += 4) longest.write('PK\x05\x06', i, 'latin1');

  for (const [name, comment] of [['tricky.zip', tricky], ['longest.zip', longest]]) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, rawZip(entries, { comment }));
    const pack = readPack(file);
    assert.equal(pack.files.length, 1, name);
    assert.equal(pack.files[0].data.toString('utf8'), 'with comment', name);
  }
});

test('readPack refuses a truncated zip and names the file', (t) => {
  const dir = tempDir(t);
  const full = path.join(dir, 'full.zip');
  zipPack(full, [{ path: 'pack/SKILL.md', data: 'some skill text that is long enough to matter' }]);
  const cut = path.join(dir, 'cut.zip');
  const bytes = fs.readFileSync(full);
  fs.writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
  assert.throws(() => readPack(cut), (err) => {
    assert.match(err.message, /not a zip|truncated/);
    assert.ok(err.message.includes(cut), 'message names the source');
    return true;
  });
});

test('readPack refuses zip64 archives', (t) => {
  const dir = tempDir(t);
  for (const marker of ['count', 'offset']) {
    const file = path.join(dir, `zip64-${marker}.zip`);
    fs.writeFileSync(file, rawZip([{ name: 'pack/SKILL.md', data: 'x' }], { marker }));
    assert.throws(() => readPack(file), /zip64/i, marker);
  }
});

test('readPack refuses a CRC mismatch and an entry that inflates past 64 MB', (t) => {
  const dir = tempDir(t);
  const badCrc = path.join(dir, 'bad-crc.zip');
  fs.writeFileSync(badCrc, rawZip([{ name: 'pack/SKILL.md', data: 'hello', badCrc: true }]));
  assert.throws(() => readPack(badCrc), /CRC/);

  const bomb = path.join(dir, 'bomb.zip');
  zipPack(bomb, [{ path: 'pack/huge.bin', data: Buffer.alloc(65 * 1024 * 1024) }]);
  assert.throws(() => readPack(bomb), /64 MB/);
});

test('readPack reads a folder recursively and skips dangling links', (t) => {
  const root = tempDir(t);
  const pack = path.join(root, 'folder-pack');
  writePack(pack, [
    { path: 'folder-pack/SKILL.md', data: Buffer.from('top') },
    { path: 'folder-pack/references/中文.md', data: Buffer.from('nested') },
  ]);
  try {
    fs.symlinkSync(path.join(root, 'missing-target'), path.join(pack, 'dangling.md'));
  } catch {
    // Symlinks need privileges on some Windows setups; the rest of the check still runs.
  }
  const result = readPack(pack);
  assert.equal(result.name, 'folder-pack');
  assert.deepEqual(result.files.map((f) => f.path).sort(), ['folder-pack/SKILL.md', 'folder-pack/references/中文.md']);
  assert.equal(result.files.find((f) => f.path.endsWith('SKILL.md')).data.toString('utf8'), 'top');
});

test('writePack refuses paths that leave the folder', (t) => {
  const dir = tempDir(t);
  for (const bad of ['../escape.md', '/abs.md', 'a/../../b.md', 'C:/x.md', 'a\\b.md', 'a//b.md']) {
    assert.throws(() => writePack(dir, [{ path: bad, data: 'x' }]), /unsafe pack path/, bad);
  }
  assert.equal(fs.existsSync(path.join(dir, '..', 'escape.md')), false);
});

test('readPack reads the real storage pack when it is present', { skip: !fs.existsSync(REAL_PACK) && `${REAL_PACK} not found` }, () => {
  const pack = readPack(REAL_PACK);
  assert.equal(pack.name, 'storage-skills-pack-v1.0');
  const skills = pack.files.filter((f) => /(?:^|\/)SKILL\.md$/.test(f.path));
  assert.ok(skills.length > 0, 'finds SKILL.md files');
  for (const f of skills) assert.ok(f.data.length > 0, `${f.path} is not empty`);
});
