import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/auth": "http://localhost:3001",
      "/billing": "http://localhost:3001",
      "/admin": "http://localhost:3001",
      "/health": "http://localhost:3001",
    },
  },
});
