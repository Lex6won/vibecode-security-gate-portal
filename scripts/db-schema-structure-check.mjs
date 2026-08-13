#!/usr/bin/env node
// PostgreSQL 인스턴스 없이 스키마의 구조적 정합성만 확인한다.
// 실행 검증을 대신하지 못한다 — DB가 준비되면 psql 로 실제 적용해 확인할 것.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const sql = readFileSync(join(root, "db", "schema.postgresql.sql"), "utf8");
const clean = sql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
const problems = [];

let depth = 0;
let lineNumber = 1;
for (const character of clean) {
  if (character === "\n") lineNumber += 1;
  if (character === "(") depth += 1;
  if (character === ")") depth -= 1;
  if (depth < 0) {
    problems.push(`괄호가 먼저 닫힘 (line ${lineNumber})`);
    break;
  }
}
if (depth !== 0) problems.push(`괄호 최종 불균형: ${depth}`);

const tables = {};
for (const match of clean.matchAll(/create table (\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const columns = [];
  for (const rawLine of match[2].split("\n")) {
    const name = rawLine.trim().match(/^(\w+)\s+/);
    if (name && !/^(primary|unique|check|foreign|constraint)$/i.test(name[1])) columns.push(name[1]);
  }
  tables[match[1]] = columns;
}

const enums = [...clean.matchAll(/create type (\w+) as enum/g)].map((match) => match[1]);
const views = [...clean.matchAll(/create view (\w+) as/g)].map((match) => match[1]);

for (const match of clean.matchAll(/references (\w+)\((\w+)\)/g)) {
  if (!tables[match[1]]) problems.push(`외래키 대상 테이블 없음: ${match[1]}`);
  else if (!tables[match[1]].includes(match[2])) problems.push(`외래키 대상 컬럼 없음: ${match[1]}.${match[2]}`);
}

for (const match of clean.matchAll(/create index (\w+) on (\w+)\(([^)]+)\)/g)) {
  const table = match[2];
  if (!tables[table]) {
    problems.push(`인덱스 대상 테이블 없음: ${table}`);
    continue;
  }
  for (const raw of match[3].split(",")) {
    const column = raw.trim().replace(/\s+(desc|asc)$/i, "");
    if (!tables[table].includes(column)) problems.push(`인덱스 컬럼 없음: ${table}.${column}`);
  }
}

for (const match of clean.matchAll(/grant [^;]*? on\s+([\s\S]*?)\s+to\s+(\w+);/g)) {
  for (const raw of match[1].split(",")) {
    const target = raw.trim();
    if (!target) continue;
    if (!tables[target] && !views.includes(target)) problems.push(`grant 대상 없음: ${target}`);
  }
}

// enum 타입으로 선언된 컬럼이 실제 정의된 enum 인지 확인한다.
const knownTypes = new Set([
  "uuid", "text", "boolean", "integer", "bigint", "date", "char", "varchar",
  "timestamptz", "numeric", "jsonb", "real", "smallint"
]);
for (const [table, columns] of Object.entries(tables)) {
  const body = clean.split(`create table ${table}`)[1]?.split("\n);")[0] || "";
  for (const match of body.matchAll(/^\s{2}(\w+)\s+(\w+)/gm)) {
    const [, column, type] = match;
    if (!columns.includes(column)) continue;
    if (knownTypes.has(type) || enums.includes(type)) continue;
    problems.push(`정의되지 않은 타입: ${table}.${column} → ${type}`);
  }
}

console.log(JSON.stringify({
  tables: Object.keys(tables).length,
  enums: enums.length,
  views,
  status: problems.length ? "failed" : "passed",
  note: "구조 검증만 수행함. 실제 적용 검증은 psql 필요.",
  problems
}, null, 2));

if (problems.length) process.exitCode = 1;
