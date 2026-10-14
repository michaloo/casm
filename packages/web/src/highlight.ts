import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
for (const [name, language] of Object.entries({
  javascript,
  typescript,
  bash,
  json,
  python,
  css,
  xml,
}))
  hljs.registerLanguage(name, language);

export function highlight(text: string, language: string) {
  return hljs.getLanguage(language)
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value
    : null;
}
