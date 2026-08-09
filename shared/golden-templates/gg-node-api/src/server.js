import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pino from "pino";
import pg from "pg";
import { z } from "zod";

const app = express();
const port = Number(process.env.PORT || 3000);
const appName = process.env.APP_NAME || "gg-node-api";
const log = pino({ level: process.env.LOG_LEVEL || "info" });

// DB는 pg 파라미터 바인딩만(문자열 조립 금지). DATABASE_URL 없으면 데모 응답(L1).
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : null;

app.use(helmet()); // 보안 헤더 레일
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60_000, max: 120 })); // 호출률 제한 레일(비용·남용 방어)

app.get("/health", (_req, res) => res.json({ status: "ok", service: appName }));

app.post("/api/items", async (req, res) => {
  const schema = z.object({ title: z.string().min(1).max(120) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  if (!pool) return res.status(201).json({ id: "demo", title: parsed.data.title });
  // 파라미터 바인딩($1) — SQLi 예방 레일
  const r = await pool.query("INSERT INTO items(title) VALUES($1) RETURNING id, title", [parsed.data.title]);
  return res.status(201).json(r.rows[0]);
});

// 인증 레일: 로그인·토큰검증 직접 구현 금지. Keycloak OIDC(openid-client)/jose로 위임.
//   행정망=Keycloak, 대민=시민 인증/익명 + 관리자 계정 분리.

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => log.info(`${appName} listening on ${port}`));
}

export default app;
