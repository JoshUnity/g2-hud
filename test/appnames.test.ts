import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Each app tells the server who it is with the third argument of connectServer. The server picks the session
 * and the feeds from the "app" parameter (server/index.ts), and no name means "answers". A missing or wrong
 * name sends no error: the app just gets no data.
 */
describe("app names", () => {
  it.each(["answers", "code", "hackos", "around", "sky"])("src/%s/main.ts passes its own name to connectServer", (app) => {
    const source = readFileSync(`src/${app}/main.ts`, "utf8");
    const at = source.indexOf("connectServer(");
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at)).toMatch(new RegExp(`^[\\s\\S]*?\\n\\s*"${app}",?\\s*\\)`));
  });

  it("the server reads the same parameter", () => {
    expect(readFileSync("server/index.ts", "utf8")).toContain('searchParams.get("app")');
  });
});
