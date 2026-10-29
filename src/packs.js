// Reads and writes skill packs: a .zip or a folder of files. Node has no zip API, so the reader
// is written here for what a pack needs (stored and deflated entries). Packs are data only:
// nothing read from them is executed.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;
const CDIR_SIZE = 46;
const LOCAL_SIZE = 30;
// The record is followed by a comment of at most 65535 bytes.
const EOCD_SEARCH = EOCD_SIZE + 0xffff;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
// Fixed DOS timestamp (1980-01-01 00:00) so the same input always gives the same zip bytes.
const DOS_TIME = 0;
const DOS_DATE = 0x21;

const fail = (source, msg) => new Error(`${source}: ${msg}`);

// A pack path is relative, forward-slashed, with no empty, '.' or '..' parts. Writers refuse
// anything else so a pack can never write outside its folder.
function safePath(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p) ||
      p.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`unsafe pack path: ${JSON.stringify(p)}`);
  }
  return p;
}

// ---- reading ----

// The end of central directory record is the last signature whose comment length reaches the
// end of the file exactly. A comment may hold the signature bytes too, so a candidate also has
// to point at a central directory that ends where the record begins.
function findEocd(buf, source) {
  const lowest = Math.max(0, buf.length - EOCD_SEARCH);
  for (let at = buf.length - EOCD_SIZE; at >= lowest; at--) {
    if (buf.readUInt32LE(at) !== EOCD_SIG) continue;
    if (at + EOCD_SIZE + buf.readUInt16LE(at + 20) !== buf.length) continue;
    const count = buf.readUInt16LE(at + 10);
    const cdSize = buf.readUInt32LE(at + 12);
    const cdOffset = buf.readUInt32LE(at + 16);
    // Zip64 markers are accepted here so that readEntries can refuse them by name.
    const zip64 = count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
    if (zip64 || cdOffset + cdSize === at) return at;
  }
  throw fail(source, 'not a zip file, or truncated (no end of central directory)');
}

function readEntries(buf, eocd, source) {
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw fail(source, 'zip64 archives are not supported; unpack the pack and read its folder');
  }
  const entries = [];
  const seen = new Set();
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + CDIR_SIZE > eocd || buf.readUInt32LE(at) !== CDIR_SIG) {
      throw fail(source, 'broken zip central directory');
    }
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const end = at + CDIR_SIZE + nameLen + extraLen + commentLen;
    if (end > eocd) throw fail(source, 'broken zip central directory');
    // Names are read as UTF-8; packs made by the usual tools set flag bit 11 for that.
    const name = buf.toString('utf8', at + CDIR_SIZE, at + CDIR_SIZE + nameLen);
    at = end;
    if (name.endsWith('/')) continue; // a directory entry carries no file
    if (flags & FLAG_ENCRYPTED) throw fail(source, `entry ${name} is encrypted`);
    if (method !== METHOD_STORED && method !== METHOD_DEFLATED) {
      throw fail(source, `entry ${name} uses unsupported compression method ${method}`);
    }
    if (seen.has(name)) throw fail(source, `entry ${name} appears twice`);
    seen.add(name);
    entries.push({ name, method, crc, csize, size, local });
  }
  return entries;
}

function readEntry(buf, e, source) {
  if (e.local + LOCAL_SIZE > buf.length || buf.readUInt32LE(e.local) !== LOCAL_SIG) {
    throw fail(source, `broken local header for ${e.name}`);
  }
  // The local header's own name and extra lengths decide where the data starts.
  const start = e.local + LOCAL_SIZE + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
  if (start + e.csize > buf.length) throw fail(source, `entry ${e.name} runs past the end of the file`);
  const packed = buf.subarray(start, start + e.csize);
  let data;
  if (e.method === METHOD_STORED) {
    data = packed;
  } else {
    try {
      data = zlib.inflateRawSync(packed, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch (err) {
      if (err.code === 'ERR_BUFFER_TOO_LARGE') throw fail(source, `entry ${e.name} inflates past 64 MB`);
      throw fail(source, `entry ${e.name} does not inflate: ${err.message}`);
    }
  }
  if (data.length !== e.size) throw fail(source, `entry ${e.name} has the wrong size`);
  if (zlib.crc32(data) !== e.crc) throw fail(source, `entry ${e.name} fails its CRC check`);
  return data;
}

function readFolder(root) {
  const files = [];
  const visit = (dir, prefix) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      // Directory symlinks are not followed, so a link loop cannot hang the reader.
      if (ent.isDirectory()) {
        visit(full, rel);
        continue;
      }
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue; // a dangling link
      }
      if (!st.isFile()) continue;
      if (st.size > MAX_ENTRY_BYTES) throw fail(root, `${rel} is larger than 64 MB`);
      files.push({ path: rel, data: fs.readFileSync(full) });
    }
  };
  visit(root, '');
  return files;
}

// Returns { name, files: [{ path, data: Buffer }] } for a .zip file or a folder. Paths are
// kept exactly as stored, forward-slashed and relative; directory entries are skipped.
export function readPack(source) {
  const name = path.basename(path.resolve(source)).replace(/\.zip$/i, '');
  if (fs.statSync(source).isDirectory()) return { name, files: readFolder(source) };
  const buf = fs.readFileSync(source);
  const eocd = findEocd(buf, source);
  const files = readEntries(buf, eocd, source).map((e) => ({ path: e.name, data: readEntry(buf, e, source) }));
  return { name, files };
}

// ---- writing ----

// Writes each file under dir, creating folders as needed.
export function writePack(dir, files) {
  for (const f of files) {
    const target = path.join(dir, ...safePath(f.path).split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
  }
}

// Writes a deflate zip of the files. Names are UTF-8 (general-purpose flag bit 11).
export function zipPack(file, files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(safePath(f.path), 'utf8');
    const data = Buffer.from(f.data);
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(LOCAL_SIZE);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_DEFLATED, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const dir = Buffer.alloc(CDIR_SIZE);
    dir.writeUInt32LE(CDIR_SIG, 0);
    dir.writeUInt16LE(20, 4); // made by: 2.0
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(FLAG_UTF8, 8);
    dir.writeUInt16LE(METHOD_DEFLATED, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);

    parts.push(local, name, packed);
    central.push(dir, name);
    offset += local.length + name.length + packed.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  if (files.length >= 0xffff || offset >= 0xffffffff) throw new Error(`${file}: too large for a plain zip (zip64 is not supported)`);

  const eocd = Buffer.alloc(EOCD_SIZE);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);

  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([...parts, ...central, eocd]));
}
