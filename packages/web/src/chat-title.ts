const HEADING = /^#{1,6}\s+(.+)$/u;
const FILLER = /^(?:(?:hi|hello|hey|cze\u015b\u0107|hej|dzie\u0144 dobry)[\s,!:.]+|(?:can|could|would|will) you\s+|(?:i (?:need|want|would like) (?:you to|to)|please|help me(?: to)?|figure out|find out|(?:how|why) (?:do|does|is|are|can) (?:i|we|it)?|(?:how|why)|the|a|an)\s+|(?:prosz\u0119|potrzebuj\u0119|chcia\u0142bym|chcia\u0142abym|chc\u0119|mo\u017cesz|czy mo\u017cesz|pom\u00f3\u017c mi|(?:\u017ce|z)by\u015b|(?:mi )?zrobi\u0142(?:a)?|zrobi\u0107|powiedz mi|jak|dlaczego)[\s,:]+)+/iu;
const GENERIC = /^(?:help|question|new (?:chat|conversation)|task|update|notes|wst\u0119p|pytanie|zadanie|pro\u015bba|nowa rozmowa|mam spraw\u0119|thanks|thank you|dzi\u0119kuj\u0119)[!.\s]*$/iu;
const CONNECTOR = /^(?:and|or|the|to|in|on|with|for|of|after|before|is|are|i|a|o|w|we|z|ze|do|dla|na|po|pod|przed|za|si\u0119|oraz)$/iu;

const REQUEST = /^(?:fix|add|remove|change|review|check|explain|investigate|update|create|write|design|test|compare|find|rename|open|napraw|dodaj|usu\u0144|zmie\u0144|sprawd\u017a|wyja\u015bnij|por\u00f3wnaj|przygotuj|utw\u00f3rz|zaktualizuj|poka\u017c|otw\u00f3rz)(?=\s|[:,.!?]|$)/iu;
const CONTEXT = /^(?:for context|some background|as discussed|here(?:'s| is) some|some context|dla kontekstu|dla jasno\u015bci|jak ustalili\u015bmy|mam (?:problem|spraw\u0119)|na pocz\u0105tek)(?:\s|[:,.!?]|$)/iu;

function shorten(phrase: string) {
  const words = phrase.split(/\s+/u);
  const title: string[] = [];
  for (const word of words.slice(0, 7)) {
    if (title.join(" ").length + word.length + 1 > 70) break;
    title.push(word);
  }
  while (title.length > 1 && CONNECTOR.test(title.at(-1)!)) title.pop();
  const result = title.join(" ") || phrase.slice(0, 70);
  return result.charAt(0).toLocaleUpperCase() + result.slice(1);
}

/** Extract a topic on the device, before sending the first message. */
export function chatTitle(text: string, attachment?: string) {
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const heading = lines.map(line => HEADING.exec(line)?.[1]).find(line => line && !GENERIC.test(line));
  if (heading) return shorten(heading);
  const first = lines[0];
  if (lines.length > 1 && first.length <= 55 && /^[\p{Lu}\p{N}][\p{Lu}\p{N} -]+$/u.test(first) && !GENERIC.test(first))
    return shorten(first);

  let candidate: string | undefined;
  for (const sentence of lines.flatMap(line => line.split(/(?<=[.!?])\s+|[;]|\u2014/u))) {
    const phrase = sentence
      .replace(/^(?:>\s*|[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/u, "")
      .replace(FILLER, "")
      .replace(/^[\s:,"'\u201e\u201c]+|[\s:,.!?;\u2026"'\u201d]+$/gu, "");
    if (!/\p{L}/u.test(phrase) || GENERIC.test(phrase) || CONTEXT.test(phrase)) continue;
    if (REQUEST.test(phrase)) return shorten(phrase);
    candidate ??= phrase;
  }
  if (candidate) return shorten(candidate);
  if (attachment) return attachment.slice(0, 70);
  return text.trim() ? "New conversation" : "Image message";
}
