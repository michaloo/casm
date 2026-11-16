// Turns CDP Accessibility.getFullAXTree nodes into the text agents read, one
// node per line, with [eN] refs for click and type. A ref is the node's
// backendDOMNodeId and the `session` key its node came with (the frame's
// target id for iframes in another process). Pure, so it is tested in Node (test/extension.test.ts).

// Structure-only roles: not printed, their children move up a level.
const SKIP = new Set(["none", "generic", "presentation", "InlineTextBox", "LineBreak", "RootWebArea", "WebArea", "Ignored", "GenericContainer"]);
const FLAGS = ["focused", "checked", "pressed", "selected", "expanded", "disabled", "required", "readonly"];
const NAME_MAX = 200;

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * @param {Array<any>} nodes AXNode list (nodeId, parentId, childIds, ignored, role, name, value, properties, backendDOMNodeId)
 * @param {{ maxLines?: number }} [opts]
 * @returns {{ text: string, refs: Record<string, { node: number, session?: string }> }}
 */
export function formatAXTree(nodes, opts = {}) {
  const maxLines = opts.maxLines ?? 2000;
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));
  const lines = [];
  const refs = {};
  let next = 0;
  let truncated = false;

  // Iterative, so a deep page can't overflow the stack: [node, depth, parent's name].
  const stack = roots.reverse().map((n) => [n, 0, ""]);
  while (stack.length) {
    const [node, depth, parentName] = stack.pop();
    const role = clean(node.role?.value);
    const name = clean(node.name?.value);
    let keep = !node.ignored && role && !SKIP.has(role);
    // Text a named parent already says (a link's own label) is noise.
    if (keep && role === "StaticText") keep = !!name && !parentName.includes(name);
    let childDepth = depth;
    let childName = parentName;
    if (keep) {
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
      let line = `${"  ".repeat(depth)}- ${role === "StaticText" ? "text" : role}`;
      if (name) line += ` ${JSON.stringify(name.length > NAME_MAX ? name.slice(0, NAME_MAX) + "…" : name)}`;
      const value = clean(node.value?.value);
      if (value && value !== name) line += ` value=${JSON.stringify(value.slice(0, NAME_MAX))}`;
      for (const p of node.properties ?? []) {
        const v = p.value?.value;
        if (p.name === "level") line += ` [level=${v}]`;
        else if (p.name === "expanded" && (v === false || v === "false")) line += " [collapsed]";
        else if (FLAGS.includes(p.name) && v !== false && v !== "false") line += v === true || v === "true" ? ` [${p.name}]` : ` [${p.name}=${v}]`;
      }
      if (node.backendDOMNodeId && role !== "StaticText") {
        const ref = `e${++next}`;
        refs[ref] = { node: node.backendDOMNodeId, ...(node.session ? { session: node.session } : {}) };
        line += ` [${ref}]`;
      }
      lines.push(line);
      childDepth = depth + 1;
      childName = name;
    }
    const children = (node.childIds ?? []).map((id) => byId.get(id)).filter(Boolean);
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], childDepth, childName]);
  }
  if (truncated) lines.push(`… cut at ${maxLines} lines: use "casm browser eval" for the rest`);
  return { text: lines.join("\n") || "(the page has no accessible content)", refs };
}
