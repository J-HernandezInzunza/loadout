// Wraps a Library so every result it returns is checked against the shared envelope (architecture.md
// §8.4, §8.5): warnings parse as Warning, and an error parses as CoreError, whose code is the closed enum.
import { z } from "zod";
import { CoreError, Warning } from "../src/model/model.ts";

const Envelope = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown(), warnings: z.array(Warning) }),
  z.object({ ok: z.literal(false), error: CoreError, warnings: z.array(Warning) }),
]);

export function checked<L extends object>(library: L): L {
  return new Proxy(library, {
    get(target, key) {
      const member: unknown = Reflect.get(target, key);
      if (typeof member !== "function") return member;
      return async (...args: unknown[]) => {
        const result: unknown = await member.apply(target, args);
        const parsed = Envelope.safeParse(result);
        if (!parsed.success) throw new Error(`${String(key)} returned a result outside the envelope: ${parsed.error.message}`);
        return result;
      };
    },
  });
}
