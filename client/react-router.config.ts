import type { Config } from "@react-router/dev/config";

export default {
  // Keep the existing src/ layout rather than React Router's default app/.
  appDirectory: "src",

  /**
   * Rendered as a SPA for now: auth tokens live in localStorage, which a
   * server-side loader can't read. Flipping this to true is the upgrade path
   * once sessions move to httpOnly cookies — at which point `clientLoader`
   * exports become `loader` and data fetching moves server-side.
   */
  ssr: false,
} satisfies Config;
