/**
 * Interactive answers for `init` (F-X-13). Reads one line per question from
 * an injectable stream; an empty line, or the end of input, keeps the default
 * (the flag value). Validation stays in `normaliseAnswers`.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  INIT_AUTH,
  INIT_CI,
  parseInitAuth,
  parseInitCi,
  type InitAnswers,
} from "./init.js";

export interface PromptIo {
  input: Readable;
  output: Writable;
}

/** Ask every `init` question, defaulting each to `defaults`. */
export async function promptInit(
  defaults: InitAnswers,
  io: PromptIo,
): Promise<InitAnswers> {
  const rl = createInterface({ input: io.input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question: string, fallback: string): Promise<string> => {
    io.output.write(`${question}${fallback ? ` [${fallback}]` : ""}: `);
    const next = await lines.next();
    const answer = next.done ? "" : String(next.value).trim();
    if (next.done) io.output.write("\n");
    return answer || fallback;
  };
  try {
    const instanceUrl = await ask(
      "Instance URL (blank: set SNPF_INSTANCE)",
      defaults.instanceUrl ?? "",
    );
    const scope = await ask(
      "Application scope (optional)",
      defaults.scope ?? "",
    );
    const auth = parseInitAuth(
      await ask(`Auth (${INIT_AUTH.join(" / ")})`, defaults.auth),
    );
    const multi = /^y(es)?$/i.test(
      await ask(
        "Several instances (registry)? y/n",
        defaults.multi ? "y" : "n",
      ),
    );
    const ci = parseInitCi(
      await ask(`CI provider (${INIT_CI.join(" / ")})`, defaults.ci),
    );
    return {
      ...(instanceUrl ? { instanceUrl } : {}),
      ...(scope ? { scope } : {}),
      auth,
      multi,
      ci,
    };
  } finally {
    rl.close();
  }
}
