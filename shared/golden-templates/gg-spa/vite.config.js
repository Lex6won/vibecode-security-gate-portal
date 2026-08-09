import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base_path 레일: nginx가 /apps/<project>/ 로 정적 서빙. 배포 시 VITE_BASE 주입(하드코딩 금지).
export default defineConfig({
  base: process.env.VITE_BASE || "/apps/gg-spa/",
  plugins: [react()],
});
