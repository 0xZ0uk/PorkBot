/**
 * The ustar archive both computer emulators and the offline shell speak.
 *
 * A snapshot archive is bytes, and every provider moves bytes: Docker's
 * archive endpoints stream a tar, and the cloud toolbox moves a tar through
 * download and upload. The emulators produce and read the same format — a real
 * ustar header, not a private encoding — so the bytes a provider's tests
 * exercise are bytes a real daemon or a real `tar` could have produced.
 *
 * The format is deliberately minimal: regular files and directories, no
 * symlinks, no long names. That is the whole surface the snapshot path needs,
 * and a small format with one writer and one reader is easier to keep honest
 * than a parser for tar's optional corners.
 */

export interface TarEntry {
  readonly name: string;
  readonly content: Uint8Array;
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);

  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");

  let checksum = 0;

  for (const byte of header) {
    checksum += byte;
  }

  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

/** Writes a real ustar archive, sorted by name so the bytes are deterministic. */
export function writeTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [...entries]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((entry) => {
      const content = Buffer.from(entry.content);
      const padding = Buffer.alloc((512 - (content.byteLength % 512)) % 512);

      return Buffer.concat([tarHeader(entry.name, content.byteLength), content, padding]);
    });

  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** Reads a ustar archive the way the daemon does; trailing blocks end it. */
export function readTar(bytes: Buffer): readonly TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);

    if (header.every((byte) => byte === 0)) {
      break;
    }

    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(header.subarray(124, 135).toString("ascii").trim(), 8);
    const start = offset + 512;
    const content = new Uint8Array(bytes.subarray(start, start + size));

    entries.push({ name, content });
    offset = start + Math.ceil(size / 512) * 512;
  }

  return entries;
}
