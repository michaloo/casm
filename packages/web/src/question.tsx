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
        p.kind === "select" && p.multiple ? (
          <fieldset key={p.id}>
            <legend>{p.text}</legend>
            <div className="question-options">
              {p.options?.map((option, index) => {
                const selected = (values[p.id] as string[]) ?? [];
                return <label className="question-option" key={option.label}>
                  <input type="checkbox" checked={selected.includes(option.label)}
                    required={index === 0 && !selected.length && !(p.allowOther && other[p.id]?.trim())}
                    onChange={(e) => set({ ...values, [p.id]: e.target.checked
                      ? [...selected, option.label] : selected.filter((value) => value !== option.label) })} />
                  <span><strong>{option.label}</strong>{option.description && <span className="option-description">{option.description}</span>}</span>
                </label>;
              })}
            </div>
            {p.allowOther &&
            <label>
              Other answers (one per line)
              <textarea
                placeholder={p.placeholder}
                value={other[p.id] ?? ""}
                onChange={(e) => setOther({ ...other, [p.id]: e.target.value })}
              />
            </label>}
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
          ) : p.kind === "text" && p.multiline && !p.secret ? (
            <textarea
              required
              placeholder={p.placeholder}
              value={String(values[p.id] ?? "")}
              onChange={(e) => set({ ...values, [p.id]: e.target.value })}
            />
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
