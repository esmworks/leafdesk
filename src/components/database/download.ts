/**
 * Saves an export the server answered with as a file, named as its Content-Disposition says
 * (else `fallback`). Throws "disabled" when the workspace turned export off, an Error otherwise.
 */
export async function saveDownload(res: Response, fallback: string): Promise<void> {
  // Export turned off since the database loaded (the menus hide it while it is off).
  if (res.status === 403 && (await res.json().catch(() => null))?.error === "disabled") throw new Error("disabled");
  if (!res.ok) throw new Error(String(res.status));
  const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get("Content-Disposition") ?? "")?.[1];
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name ? decodeURIComponent(name) : fallback;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
