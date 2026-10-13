// A tiny reader for .d.ts files: enough to resolve type aliases, unions,
// intersections and object/interface members, and to pull out string
// literals. TypeScript 7 ships no JS compiler API, so we parse by hand.

export class Dts {
  private src: string;

  constructor(text: string) {
    // Drop comments: they contain braces, quotes and example code.
    this.src = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  // The text after `=` for `type NAME = ...;`, or the `{...}` body (plus
  // `extends` clause) for `interface NAME ... {...}`. Null if not found.
  decl(name: string): { kind: "type" | "interface"; text: string; extends: string[] } | null {
    const typeRe = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+${name}\\s*(?:<[^=]*>)?\\s*=`, "g");
    const t = typeRe.exec(this.src);
    if (t) {
      const start = t.index + t[0].length;
      return { kind: "type", text: this.until(start, ";").trim(), extends: [] };
    }
    const ifRe = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:declare\\s+)?interface\\s+${name}\\b([^{]*)\\{`, "g");
    const i = ifRe.exec(this.src);
    if (i) {
      const open = i.index + i[0].length - 1;
      const close = this.matching(open);
      const ext = /extends\s+(.*)$/s.exec(i[1].trim());
      return {
        kind: "interface",
        text: this.src.slice(open, close + 1),
        extends: ext ? splitTop(ext[1], ",").map((s) => s.trim().replace(/<.*$/s, "")) : [],
      };
    }
    return null;
  }

  // Index of the bracket that closes the one at `open`.
  private matching(open: number): number {
    let depth = 0;
    for (let i = open; i < this.src.length; i++) {
      const c = this.src[i];
      if (c === "'" || c === '"' || c === "`") {
        i = skipString(this.src, i);
        continue;
      }
      if (c === "{" || c === "(" || c === "[" || c === "<") depth++;
      else if (c === "}" || c === ")" || c === "]" || (c === ">" && this.src[i - 1] !== "=")) {
        depth--;
        if (depth === 0) return i;
      }
    }
    throw new Error("unbalanced brackets");
  }

  // Text from `start` up to a top-level terminator.
  private until(start: number, term: string): string {
    let depth = 0;
    for (let i = start; i < this.src.length; i++) {
      const c = this.src[i];
      if (c === "'" || c === '"' || c === "`") {
        i = skipString(this.src, i);
        continue;
      }
      if (c === "{" || c === "(" || c === "[") depth++;
      else if (c === "}" || c === ")" || c === "]") depth--;
      else if (depth === 0 && c === term) return this.src.slice(start, i);
    }
    return this.src.slice(start);
  }

  // The object shapes a type name resolves to: aliases and unions are
  // followed, intersections merged. Unknown names (imports) are skipped.
  objects(name: string, seen = new Set<string>()): Member[][] {
    if (seen.has(name)) return [];
    seen.add(name);
    const d = this.decl(name);
    if (!d) return [];
    if (d.kind === "interface") {
      const base = d.extends.flatMap((e) => this.objects(e, seen));
      const own = members(d.text);
      return base.length ? base.map((b) => [...b, ...own]) : [own];
    }
    return this.shapes(d.text, seen);
  }

  shapes(text: string, seen: Set<string>): Member[][] {
    const alts = splitTop(text, "|").map((s) => s.trim()).filter(Boolean);
    const out: Member[][] = [];
    for (const alt of alts) {
      let combos: Member[][] = [[]];
      for (const part of splitTop(alt, "&").map((s) => s.trim())) {
        const sub = part.startsWith("{") ? [members(part)] : /^[A-Za-z_$][\w$]*$/.test(part) ? this.objects(part, new Set(seen)) : [];
        if (!sub.length) continue;
        combos = combos.flatMap((c) => sub.map((s) => [...c, ...s]));
      }
      out.push(...combos);
    }
    return out;
  }

  // Identifiers of a `type X = A | B | C` alias.
  unionNames(name: string): string[] {
    const d = this.decl(name);
    if (!d || d.kind !== "type") return [];
    return splitTop(d.text, "|").map((s) => s.trim()).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
  }

  // String literals of a `type X = 'a' | 'b'` alias or `const X: readonly ['a', ...]`.
  literals(name: string): string[] {
    const d = this.decl(name);
    if (d) return stringLiterals(d.text);
    const c = new RegExp(`(?:export\\s+)?declare\\s+const\\s+${name}\\s*:\\s*`).exec(this.src);
    return c ? stringLiterals(this.until(c.index + c[0].length, ";")) : [];
  }
}

export type Member = { name: string; optional: boolean; type: string; method: boolean };

// Top-level members of a `{ ... }` object type.
export function members(body: string): Member[] {
  const inner = body.trim().replace(/^\{/, "").replace(/\}$/, "");
  const out: Member[] = [];
  for (const raw of splitTop(inner, ";")) {
    const s = raw.trim().replace(/^readonly\s+/, "");
    if (!s || s.startsWith("[")) continue; // index signatures
    const m = /^([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")(\?)?\s*(\(|<|:)/.exec(s);
    if (!m) continue;
    const method = m[3] === "(" || m[3] === "<";
    out.push({ name: m[1].replace(/^['"]|['"]$/g, ""), optional: !!m[2], type: s.slice(m[0].length - (method ? 1 : 0)), method });
  }
  return out;
}

export function stringLiterals(text: string): string[] {
  return [...text.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
}

// Splits on any of `seps` at bracket depth 0, outside strings.
export function splitTop(text: string, seps: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === "`") {
      i = skipString(text, i);
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === "<") depth++;
    else if (c === ">" && text[i - 1] !== "=") depth--;
    else if (depth === 0 && seps.includes(c)) {
      out.push(text.slice(last, i));
      last = i + 1;
    }
  }
  out.push(text.slice(last));
  return out;
}

function skipString(text: string, i: number): number {
  const q = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === q) return j;
  }
  return text.length;
}
