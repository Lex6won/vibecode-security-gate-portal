import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

function App() {
  const [query, setQuery] = useState("");
  return <main className="shell">
    <h1>공공 바이브코딩 SPA</h1>
    <label>검색어<input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={60} /></label>
    <section aria-live="polite">입력값: {query || "없음"}</section>
  </main>;
}

createRoot(document.getElementById("root")).render(<App />);
