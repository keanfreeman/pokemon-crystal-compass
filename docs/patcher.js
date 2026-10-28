// Applies a BPS patch (https://www.romhacking.net/documents/746/) in the
// browser: no upload, the ROM never leaves the player's machine. Also loads
// in Node for the publish check (tools/publish/check_patcher.mjs).

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, end = bytes.length) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function readU32(bytes, at) {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

// -> the patched ROM (Uint8Array); throws Error with a message for the player
export function applyBps(source, patch) {
  if (patch.length < 16 || String.fromCharCode(...patch.subarray(0, 4)) !== 'BPS1') {
    throw new Error('The patch file is damaged (not a BPS patch).');
  }
  if (crc32(patch, patch.length - 4) !== readU32(patch, patch.length - 4)) {
    throw new Error('The patch file is damaged (its checksum doesn\'t match).');
  }
  let at = 4;
  const number = () => {
    let value = 0, shift = 1;
    for (;;) {
      const x = patch[at++];
      value += (x & 0x7F) * shift;
      if (x & 0x80) return value;
      shift *= 128;
      value += shift;
    }
  };
  const sourceSize = number();
  const targetSize = number();
  const metadata = number();                       // (number() moves `at`: not `at += number()`)
  at += metadata;
  if (source.length !== sourceSize || crc32(source) !== readU32(patch, patch.length - 12)) {
    throw new Error('This isn\'t the ROM the patch is for.');
  }
  const target = new Uint8Array(targetSize);
  let out = 0, sourceRel = 0, targetRel = 0;
  const end = patch.length - 12;
  while (at < end) {
    const data = number();
    const length = (data >> 2) + 1;
    switch (data & 3) {
      case 0:                                        // SourceRead
        target.set(source.subarray(out, out + length), out);
        out += length;
        break;
      case 1:                                        // TargetRead
        target.set(patch.subarray(at, at + length), out);
        at += length;
        out += length;
        break;
      case 2: {                                      // SourceCopy
        const offset = number();
        sourceRel += (offset & 1 ? -1 : 1) * (offset >> 1);
        target.set(source.subarray(sourceRel, sourceRel + length), out);
        sourceRel += length;
        out += length;
        break;
      }
      default: {                                     // TargetCopy (may overlap)
        const offset = number();
        targetRel += (offset & 1 ? -1 : 1) * (offset >> 1);
        for (let i = 0; i < length; i++) target[out++] = target[targetRel++];
      }
    }
  }
  if (crc32(target) !== readU32(patch, patch.length - 8)) {
    throw new Error('Patching went wrong (the result\'s checksum doesn\'t match).');
  }
  return target;
}

export async function sha1(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
