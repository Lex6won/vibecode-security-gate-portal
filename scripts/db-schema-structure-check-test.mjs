#!/usr/bin/env node
import assert from "node:assert/strict";
import { stripSqlLineComments } from "../src/sql-structure.mjs";

const lf = "select auth.uid() -- comment with auth.uid()\nfrom jobs;\n";
const crlf = lf.replaceAll("\n", "\r\n");
const expected = "select auth.uid() \nfrom jobs;\n";

assert.equal(stripSqlLineComments(lf), expected);
assert.equal(stripSqlLineComments(crlf), expected);

console.log("db schema structure check test passed");
