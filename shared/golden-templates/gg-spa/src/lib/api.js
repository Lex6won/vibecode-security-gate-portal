// 데이터 호출은 이 파일 한 곳으로만 모은다(레일).
// 컴포넌트에서 직접 fetch/외부 SDK 호출 금지. supabase-js·firebase 등 외부 BaaS 직접 호출 금지.
// 항상 내부 API(FastAPI/Express)만 호출한다.
const BASE = import.meta.env.VITE_API_BASE || "/api";

export async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

export async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}
