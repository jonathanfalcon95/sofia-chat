import type { ReactNode } from "react";

/**
 * Renders WhatsApp-style text formatting:
 * *bold*  _italic_  ~strike~  `code`  ```code block```
 * Preserves newlines via parent whitespace-pre-wrap.
 */
export function WhatsAppText({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  // Normalize escaped newlines sometimes stored from APIs/bots
  const normalized = text.replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
  return <>{parseBlocks(normalized)}</>;
}

function parseBlocks(input: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /```([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = re.exec(input)) !== null) {
    if (match.index > last) {
      nodes.push(...parseInline(input.slice(last, match.index), `t-${key++}`));
    }
    nodes.push(
      <pre
        key={`c-${key++}`}
        className="my-1 overflow-x-auto rounded-md bg-black/20 px-2 py-1 font-mono text-[12px] leading-relaxed whitespace-pre-wrap"
      >
        {match[1]}
      </pre>,
    );
    last = match.index + match[0].length;
  }

  if (last < input.length) {
    nodes.push(...parseInline(input.slice(last), `t-${key++}`));
  }

  return nodes;
}

function parseInline(input: string, keyPrefix: string): ReactNode[] {
  // Bold / italic / strike / inline code (non-greedy, same-line)
  const re =
    /(\*[^*\n]+?\*|_[^_\n]+?_|~[^~\n]+?~|`[^`\n]+`)/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = re.exec(input)) !== null) {
    if (match.index > last) {
      nodes.push(input.slice(last, match.index));
    }
    const token = match[0];
    const inner = token.slice(1, -1);
    const k = `${keyPrefix}-${i++}`;

    if (token.startsWith("`")) {
      nodes.push(
        <code
          key={k}
          className="rounded bg-black/20 px-1 py-0.5 font-mono text-[12px]"
        >
          {inner}
        </code>,
      );
    } else if (token.startsWith("*")) {
      nodes.push(
        <strong key={k} className="font-semibold">
          {parseInline(inner, `${k}-i`)}
        </strong>,
      );
    } else if (token.startsWith("_")) {
      nodes.push(
        <em key={k} className="italic">
          {parseInline(inner, `${k}-i`)}
        </em>,
      );
    } else if (token.startsWith("~")) {
      nodes.push(
        <span key={k} className="line-through opacity-90">
          {parseInline(inner, `${k}-i`)}
        </span>,
      );
    }

    last = match.index + token.length;
  }

  if (last < input.length) {
    nodes.push(input.slice(last));
  }

  return nodes;
}
