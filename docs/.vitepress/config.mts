import { defineConfig } from "vitepress";

// Preserve Vite 6's targets except Safari 14, whose destructuring target is
// unsupported by the repository's patched esbuild. Apply to build and dev.
const browserTargets = ["es2020", "chrome87", "edge88", "firefox78", "safari14.1"];

export default defineConfig({
  title: "DialCache",
  description:
    "DialCache organizes caching into use cases, with runtime control and observability for each one. Reference for the read path, runtime policies, and the API.",
  lang: "en-US",
  base: "/DialCache/",
  vite: {
    build: { target: browserTargets },
    optimizeDeps: { esbuildOptions: { target: browserTargets } },
  },
  themeConfig: {
    nav: [
      { text: "Documentation", link: "/" },
      { text: "API reference", link: "/api" },
      { text: "npm", link: "https://www.npmjs.com/package/dialcache" },
    ],
    sidebar: [
      {
        text: "Start here",
        items: [
          { text: "Overview", link: "/" },
          { text: "Getting started", link: "/getting-started" },
          { text: "How DialCache works", link: "/concepts" },
        ],
      },
      {
        text: "Features and behavior",
        items: [
          { text: "Configuration", link: "/configuration" },
          { text: "Redis and Valkey", link: "/redis" },
          { text: "Targeted invalidation", link: "/invalidation" },
          { text: "Stale-on-error", link: "/stale-on-error" },
          { text: "Shadow validation", link: "/shadow-validation" },
          { text: "Coalescing and liveness", link: "/coalescing" },
          { text: "Observability", link: "/observability" },
        ],
      },
      {
        text: "Reference and operations",
        items: [
          { text: "API reference", link: "/api" },
          { text: "Upgrading", link: "/upgrading" },
          { text: "Maintainer guide", link: "/maintainers" },
        ],
      },
    ],
    outline: [2, 3],
    search: { provider: "local" },
    socialLinks: [
      { icon: "github", link: "https://github.com/lan17/DialCache" },
    ],
    editLink: {
      pattern: "https://github.com/lan17/DialCache/edit/main/docs/:path",
    },
  },
});
