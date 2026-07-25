/**
 * Minimal ZIP reader for subtitle archives.
 *
 * Both SubDL and SubSource deliver subtitles as ZIPs, and a player can't use a
 * ZIP — we have to pull the subtitle file out. Rather than add a dependency
 * (which would churn the lockfile and conflict with upstream on every merge),
 * this implements just the subset those archives use: a central directory of
 * small entries, stored (0) or deflate (8). `zlib.inflateRaw` does the actual
 * decompression.
 *
 * Anything outside that subset (encryption, zip64, other codecs) throws with a
 * clear message rather than silently returning garbage.
 */
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** EOCD is 22 bytes plus an optional trailing comment (max 64KB). */
const MAX_EOCD_SCAN = 22 + 0xffff;

export interface ZipEntry {
  name: string;
  /** Uncompressed size as recorded in the central directory. */
  size: number;
  read(): Buffer;
}

function findEocd(buf: Buffer): number {
  const start = Math.max(0, buf.length - MAX_EOCD_SCAN);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** List the entries in a ZIP archive. Bodies are decompressed lazily. */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd === -1)
    throw new Error('Not a ZIP archive (no end-of-central-directory)');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }

  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIG) {
      break; // truncated or malformed central directory — use what we have
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    // Bit 0 of the general-purpose flags marks an encrypted entry.
    const encrypted = (flags & 0x1) !== 0;

    entries.push({
      name,
      size: uncompSize,
      read(): Buffer {
        if (encrypted) {
          throw new Error(`ZIP entry "${name}" is encrypted`);
        }
        if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
          throw new Error(`ZIP entry "${name}" has a bad local header`);
        }
        // The local header repeats the name/extra lengths, and they can differ
        // from the central directory's — the data starts after the local ones.
        const lNameLen = buf.readUInt16LE(localOffset + 26);
        const lExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + lNameLen + lExtraLen;
        const body = buf.subarray(dataStart, dataStart + compSize);
        if (method === 0) return Buffer.from(body);
        if (method === 8) return inflateRawSync(body);
        throw new Error(
          `ZIP entry "${name}" uses unsupported compression method ${method}`
        );
      },
    });

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const SUBTITLE_EXT = /\.(srt|ass|ssa|vtt|sub)$/i;

/** Entries that look like subtitle files, ignoring macOS/dotfile cruft. */
export function subtitleEntries(entries: ZipEntry[]): ZipEntry[] {
  return entries.filter(
    (e) =>
      SUBTITLE_EXT.test(e.name) &&
      !e.name.startsWith('__MACOSX/') &&
      !e.name.split('/').pop()?.startsWith('.')
  );
}
