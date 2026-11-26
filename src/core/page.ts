import { CreateStartUpPageContainer, RebuildPageContainer, StartUpPageCreateResult, type EvenAppBridge } from "@evenrealities/even_hub_sdk";

export type PageSpec = Pick<RebuildPageContainer, "containerTotalNum" | "listObject" | "textObject" | "imageObject" | "menuObject">;

/**
 * Opens the first page. The host accepts createStartUpPageContainer once per
 * launch and keeps the page when the WebView reloads (a Vite reload, for
 * example), so a refused create falls back to replacing that page. The caller
 * continues either way: after a reload the old page still has the same
 * containers, so input and updates can still work.
 *
 * `startedUp` is true when the intro splash already made the start-up page.
 * Then the app's page replaces it: a rebuild, tried twice, as the host may
 * still be busy with the last splash frame.
 */
export async function openPage(bridge: EvenAppBridge, spec: PageSpec, startedUp = false): Promise<boolean> {
  if (startedUp) {
    const rebuild = () => bridge.rebuildPageContainer(new RebuildPageContainer(spec));
    if (await rebuild()) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return rebuild();
  }
  const created = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(spec));
  if (created === StartUpPageCreateResult.success) return true;
  return bridge.rebuildPageContainer(new RebuildPageContainer(spec));
}

/** A lasting note on the phone page; status lines are overwritten, this is not. */
export function notePageFailure(): void {
  const note = document.createElement("p");
  note.textContent = "The glasses page could not be created. If the glasses do not respond, close the app on the glasses and open it again.";
  document.body.prepend(note);
}
