// HWPX 틀 치환 엔진 (P3 후속 — 보안성검토 요청서 자동 생성의 뼈대)
//
// HWPX(OWPML, KS X 6101)는 XML 문서를 담은 ZIP 이다. 요청서 양식(틀)에
// {{기관명}} 같은 자리표시자를 넣어 두면, 이 모듈이 ZIP 을 풀어 XML 안의
// 자리표시자를 실제 값으로 바꾸고 다시 ZIP 으로 묶어 정상 HWPX 를 만든다.
//
// 설계 원칙:
//  - 외부 의존성 없음 — ZIP 읽기/쓰기를 Node 내장(zlib)만으로 구현한다.
//    (서버 OS 미확정: PowerShell 의존을 새로 만들지 않는다 — docs/29 §B-2)
//  - 틀은 사람이 만든다. 엔진은 치환·검증만 한다.
//  - 엄격 모드: 값이 없는 자리표시자가 남으면 실패한다 — 공문서에 빈칸이
//    남는 사고를 실수로 만들 수 없게 한다(옵션으로 완화 가능).
//  - 한글 편집기는 한 단어를 여러 조각(run)으로 쪼개 저장할 수 있어
//    {{ 와 }} 사이에 XML 태그가 끼면 치환이 안 된다. validateTemplate 이
//    이런 쪼개진 자리표시자를 찾아 경고한다(틀 검수용 — 양식 수령 시 1회 실행).
import { deflateRawSync, inflateRawSync } from "node:zlib";

const PLACEHOLDER_PATTERN = /\{\{([^{}<>]{1,80})\}\}/g;
const TEXT_ENTRY_PATTERN = /\.(xml|hpf|opf)$/i;

// ---------------------------------------------------------------- ZIP 읽기

function findEndOfCentralDirectory(buffer) {
  // EOCD(0x06054b50)를 뒤에서부터 찾는다. 주석 최대 65535바이트를 감안한다.
  const minimum = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("HWPX(ZIP) 형식이 아닙니다: 중앙 디렉터리를 찾지 못했습니다.");
}

export function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("HWPX(ZIP) 형식이 아닙니다: 중앙 디렉터리 항목이 손상되었습니다.");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const modTime = buffer.readUInt16LE(offset + 12);
    const modDate = buffer.readUInt16LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    // 로컬 헤더에서 실제 데이터 위치를 계산한다(로컬의 name/extra 길이는 다를 수 있음).
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`HWPX(ZIP) 형식이 아닙니다: ${name} 의 로컬 헤더가 손상되었습니다.`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(compressed) : method === 0 ? Buffer.from(compressed) : null;
    if (data === null) {
      throw new Error(`지원하지 않는 압축 방식(${method})입니다: ${name}`);
    }
    entries.push({ name, data, method, flags, modTime, modDate });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ---------------------------------------------------------------- ZIP 쓰기

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function writeZipEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let position = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.data);
    // 원본의 압축 방식을 유지한다. mimetype 처럼 비압축(0) 항목은 그대로 둬야
    // 읽는 쪽(한글 등)이 형식을 확인할 수 있다.
    const compressed = entry.method === 8 ? deflateRawSync(entry.data, { level: 9 }) : entry.data;
    // 일반 플래그: 데이터 서술자(bit3)는 쓰지 않고, UTF-8 이름(bit11)만 유지한다.
    const flags = (entry.flags & 0x0800) | 0x0000;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(entry.modTime, 10);
    local.writeUInt16LE(entry.modDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(entry.modTime, 12);
    central.writeUInt16LE(entry.modDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(position, 42);

    localParts.push(local, nameBytes, compressed);
    centralParts.push(Buffer.concat([central, nameBytes]));
    position += 30 + nameBytes.length + compressed.length;
  }

  const centralStart = position;
  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

// ---------------------------------------------------------------- 치환·검증

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// 틀 검수: 자리표시자 목록과, 편집기가 쪼개 놓아 치환이 불가능한 후보를 찾는다.
// 양식(HWPX 틀)을 받으면 이 함수를 먼저 돌려 경고 0건을 확인한다.
export function validateTemplate(hwpxBuffer) {
  const placeholders = new Set();
  const warnings = [];
  for (const entry of readZipEntries(hwpxBuffer)) {
    if (!TEXT_ENTRY_PATTERN.test(entry.name)) continue;
    const xml = entry.data.toString("utf8");
    for (const match of xml.matchAll(PLACEHOLDER_PATTERN)) placeholders.add(match[1].trim());
    // {{ 와 }} 사이에 태그가 끼어 있으면(= run 분리) 완전한 자리표시자로 잡히지 않는다.
    for (const broken of xml.matchAll(/\{\{(?:(?!\}\})[\s\S]){0,200}?<[\s\S]{0,400}?\}\}/g)) {
      const readable = broken[0].replace(/<[^>]*>/g, "").slice(0, 60);
      warnings.push(`쪼개진 자리표시자로 보입니다(${entry.name}): "${readable}" — 틀에서 지우고 한 번에 다시 붙여넣어 주세요.`);
    }
    const residualOpen = xml.replace(PLACEHOLDER_PATTERN, "").match(/\{\{[^<]{0,40}/g) || [];
    for (const fragment of residualOpen) {
      warnings.push(`닫히지 않은 자리표시자(${entry.name}): "${fragment.slice(0, 50)}"`);
    }
  }
  return { placeholders: [...placeholders].sort(), warnings };
}

// 치환: values 의 값은 XML 이스케이프되어 들어간다(값에 무엇이 오든 문서가 깨지지 않는다).
// 엄격 모드(기본): 값이 준비되지 않은 자리표시자가 남으면 실패한다.
export function fillTemplate(hwpxBuffer, values, options = {}) {
  const strict = options.strict !== false;
  const replaced = new Set();
  const missing = new Set();
  const entries = readZipEntries(hwpxBuffer).map((entry) => {
    if (!TEXT_ENTRY_PATTERN.test(entry.name)) return entry;
    const xml = entry.data.toString("utf8");
    const updated = xml.replace(PLACEHOLDER_PATTERN, (whole, rawKey) => {
      const key = rawKey.trim();
      if (Object.hasOwn(values, key)) {
        replaced.add(key);
        return escapeXml(values[key] ?? "");
      }
      missing.add(key);
      return whole;
    });
    return updated === xml ? entry : { ...entry, data: Buffer.from(updated, "utf8") };
  });
  if (strict && missing.size > 0) {
    throw new Error(`값이 준비되지 않은 자리표시자가 있습니다: ${[...missing].join(", ")}`);
  }
  return { buffer: writeZipEntries(entries), replaced: [...replaced].sort(), missing: [...missing].sort() };
}
