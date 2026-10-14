// User messages (including agent reports) keep intentional soft line breaks.
// Transform parsed text only: fenced/inline code and Markdown structure stay intact.
type Node = { type: string; value?: string; children?: Node[] };
export function userLineBreaks() {
  return function transform(node: Node) {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text" && child.value?.includes("\n")) {
        return child.value.split("\n").flatMap((value, index) =>
          index ? [{ type: "break" }, { type: "text", value }] : [{ type: "text", value }],
        );
      }
      transform(child);
      return [child];
    });
  };
}
