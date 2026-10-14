import { useState } from "react";
import type { Answers, QuestionRequest } from "@casm/protocol";

export function Question({
  request,
  answer,
}: {
  request: QuestionRequest;
  answer: (answers?: Answers) => void;
}) {
  const [values, set] = useState<Answers>({});
  const [other, setOther] = useState<Record<string, string>>({});
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        const answers = { ...values };
        for (const prompt of request.prompts) {
          if (prompt.kind === "select" && prompt.multiple && prompt.allowOther) {
            answers[prompt.id] = [
              ...((values[prompt.id] as string[]) ?? []),
              ...(other[prompt.id] ?? "").split("\n").map((line) => line.trim()).filter(Boolean),
            ];
          }
        }
        answer(answers);
      }}
    >
      <strong>{request.title ?? "Question"}</strong>
      {request.prompts.map((p) => (
        p.kind === "select" && p.multiple && p.allowOther ? (
          <fieldset key={p.id}>
            <legend>{p.text}</legend>
            <label>
              Options
              <select
                multiple
                required={!other[p.id]?.trim()}
                value={(values[p.id] as string[]) ?? []}
                onChange={(e) => set({
                  ...values,
                  [p.id]: Array.from(e.target.selectedOptions, (option) => option.value),
                })}
              >
                {p.options?.map((option) => (
                  <option key={option.label} value={option.label}>
                    {option.label}{option.description ? ` — ${option.description}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Other answers (one per line)
              <textarea
                placeholder={p.placeholder}
                value={other[p.id] ?? ""}
                onChange={(e) => setOther({ ...other, [p.id]: e.target.value })}
              />
            </label>
          </fieldset>
        ) : <label key={p.id}>
          {p.text}
          {p.kind === "confirm" ? (
            <select
              required
              value={String(values[p.id] ?? "")}
              onChange={(e) =>
                set({ ...values, [p.id]: e.target.value === "true" })
              }
            >
              <option value="">Choose…</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : p.kind === "select" && !p.allowOther ? (
            <select
              required
              multiple={p.multiple}
              value={
                p.multiple
                  ? ((values[p.id] as string[]) ?? [])
                  : ((values[p.id] as string) ?? "")
              }
              onChange={(e) =>
                set({
                  ...values,
                  [p.id]: p.multiple
                    ? Array.from(e.target.selectedOptions, (o) => o.value)
                    : e.target.value,
                })
              }
            >
              {!p.multiple && <option value="">Choose…</option>}
              {p.options?.map((o) => (
                <option key={o.label} value={o.label}>
                  {o.label}
                  {o.description ? ` — ${o.description}` : ""}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input
                required
                type={p.secret ? "password" : "text"}
                placeholder={p.placeholder}
                list={`options-${p.id}`}
                value={String(values[p.id] ?? "")}
                onChange={(e) => set({ ...values, [p.id]: e.target.value })}
              />
              <datalist id={`options-${p.id}`}>
                {p.options?.map((o) => (
                  <option key={o.label}>{o.label}</option>
                ))}
              </datalist>
            </>
          )}
        </label>
      ))}
      <button>Answer</button>
      <button type="button" onClick={() => answer()}>
        Dismiss
      </button>
    </form>
  );
}
