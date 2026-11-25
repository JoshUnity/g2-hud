import { CreateStartUpPageContainer, RebuildPageContainer, StartUpPageCreateResult, type EvenAppBridge } from "@evenrealities/even_hub_sdk";

export type PageSpec = Pick<RebuildPageContainer, "containerTotalNum" | "listObject" | "textObject" | "imageObject" | "menuObject">;

/**
 * Opens the first page. The host accepts createStartUpPageContainer once per
 * launch and keeps the page when the WebView reloads (a Vite reload, for
 * example), so a refused create falls back to replacing that page. The caller
 * continues either way: after a reload the old page still has the same
 * containers, so input and updates can still work.
 */
export async function openPage(bridge: EvenAppBridge, spec: PageSpec): Promise<boolean> {
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
