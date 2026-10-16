// Just enough of a zip reader to pull one file out of a download, with no dependencies.
// Sizes come from the central directory, because some zips (the Environment Agency's)
// leave them as zero in the local headers.
import zlib from 'node:zlib';

/** Find the first entry whose name matches `match`. Returns { name, data, modified } or null. */
export function readZipEntry(buf, match) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('Not a zip file.');

  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Not a zip file (bad central directory).');
    const method = buf.readUInt16LE(p + 10);
    const date = buf.readUInt16LE(p + 14);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!match.test(name)) continue;

    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + size);
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = zlib.inflateRawSync(body);
    else throw new Error(`Unsupported zip compression (method ${method}).`);
    const pad = (x) => String(x).padStart(2, '0');
    const modified = `${(date >> 9) + 1980}-${pad((date >> 5) & 15)}-${pad(date & 31)}`;
    return { name, data, modified };
  }
  return null;
}
