import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "./scripts/vite-tsconfig-paths.ts";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
});
