import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  // host: true 同时监听 IPv4/IPv6，否则只绑 [::1]，浏览器敲 127.0.0.1 会连不上
  server: { host: true, port: 5173, proxy: { "/api": "http://127.0.0.1:8790" } },
});
