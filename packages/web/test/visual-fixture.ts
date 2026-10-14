import type { Item } from "@casm/protocol";
export const visualItems: Item[] = [
  {
    kind: "user",
    id: "v-user",
    text: "Give the agent workspace a little breathing room. Keep it focused, and show me what changed.",
  },
  {
    kind: "assistant",
    id: "v-intro",
    text: "## A calmer place to work\n\nI refined the workspace around **readability**, clear status, and fewer distractions. The violet and teal accents come directly from the casm mark.\n\n- A quiet sidebar that keeps your agents close\n- Tools that stay compact until you need the details\n- A composer that always stays within reach\n\n> Good tools make room for the work.\n\nSee the [implementation notes](https://example.com/notes), or inspect `packages/web` below.",
  },
  {
    kind: "reasoning",
    id: "v-thinking",
    text: "First I will check the layout constraints, then compare light and dark surfaces. The composer must remain visible with a long queue.",
  },
  {
    kind: "tool",
    id: "v-bash",
    name: "Bash",
    input: {
      command: "npm run check --workspace @casm/web",
      description: "Validate the updated workspace",
    },
    status: "done",
    output: Array.from(
      { length: 200 },
      (_, i) =>
        `  ✓ ${String(i + 1).padStart(3, "0")}  workspace check passed · no layout regressions`,
    ).join("\n"),
  },
  {
    kind: "tool",
    id: "v-diff",
    name: "Edit",
    input: { file_path: "packages/web/src/theme.css" },
    status: "done",
    output:
      "diff --git a/theme.css b/theme.css\n--- a/theme.css\n+++ b/theme.css\n@@ -1,3 +1,4 @@\n :root {\n-  --accent: #245fa3;\n+  --accent: #7952b5;\n+  --teal: #16877e;\n }",
  },
  {
    kind: "tool",
    id: "v-running",
    name: "Read",
    input: { file_path: "packages/web/src/transcript.tsx" },
    status: "running",
    output: "Reading the transcript renderer…",
  },
  {
    kind: "tool",
    id: "v-error-tool",
    name: "Bash",
    input: { command: "npm run legacy-check" },
    status: "error",
    output: "Unknown script: legacy-check. Use npm run check instead.",
  },
  {
    kind: "subagent",
    id: "v-subagent",
    title: "Review responsive layout",
    status: "done",
    activity: "Checked desktop and mobile",
    summary:
      "The message column stays comfortable to read. Wide tables scroll inside their own container.",
  },
  {
    kind: "notice",
    id: "v-notice",
    text: "Reconnected. Your conversation and unsent draft are up to date.",
    level: "info",
  },
  {
    kind: "notice",
    id: "v-warning",
    text: "This tool needs your attention before the next step.",
    level: "warning",
  },
  {
    kind: "notice",
    id: "v-error",
    text: "A check failed. Its output is preserved above so you can retry.",
    level: "error",
  },
  {
    kind: "plan",
    id: "v-plan",
    entries: [
      { text: "Refine the type scale and surfaces", status: "completed" },
      { text: "Check both color schemes", status: "in_progress" },
      { text: "Review the mobile conversation", status: "pending" },
    ],
  },
  {
    kind: "assistant",
    id: "v-code",
    text: '### Small details, clear intent\n\nThe layout uses native CSS variables and a system font stack. No remote fonts or extra requests.\n\n```typescript\ntype AgentStatus = "idle" | "running" | "waiting";\n\nexport function statusLabel(status: AgentStatus): string {\n  return status === "waiting" ? "Needs you" : status;\n}\n```\n\n| Surface | Light mode | Dark mode | Purpose |\n| :--- | :--- | :--- | :--- |\n| Conversation | Porcelain | Ink | Keep the prose easy to read |\n| Accent | Soft violet | Lavender | Selection and primary actions |\n| Status | Evergreen | Sea glass | Progress without distraction |\n\n1. Open a conversation.\n2. Make a plan.\n3. Let the agents work.\n\n![casm app icon](/icon-192.png)',
  },
];
