/**
 * The app's own screen (pages/app.html): picking the server, a certificate to trust, a server that
 * didn't answer. A plain script, not a module (module scripts don't load from file: pages), so it
 * imports nothing; the shapes below mirror main.ts. Built with tsconfig.pages.json.
 */

type PageCertificate = { host: string; fingerprint: string; subject: string; issuer: string; validUntil: string; error: string };

type PageState = {
  locale: string;
  dir: "ltr" | "rtl";
  strings: Record<string, string>;
  current?: string;
  localAvailable: boolean;
} & (
  | { view: "connect"; address?: string }
  | { view: "starting" }
  | { view: "problem"; server: string; detail: string; certificate?: PageCertificate; local?: boolean }
);

type PageConnectReply =
  | { ok: true }
  | { error: "invalid" }
  | { error: "unreachable"; host: string }
  | { error: "not-leafdesk"; host: string }
  | { error: "certificate"; host: string; certificate: PageCertificate };

interface Window {
  leafdesk: {
    state(): Promise<PageState>;
    connect(address: string, force: boolean): Promise<PageConnectReply>;
    trust(host: string, fingerprint: string): Promise<{ ok: boolean }>;
    retry(): Promise<void>;
    startLocal(): Promise<void>;
  };
}

{
  const bridge = window.leafdesk;
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const sections = ["connect", "certificate", "starting", "problem"].map((id) => byId(id));
  const form = byId<HTMLFormElement>("server-form");
  const input = byId<HTMLInputElement>("address");
  const connectButton = byId<HTMLButtonElement>("connect-button");
  const anyway = byId<HTMLButtonElement>("anyway");
  const back = byId<HTMLButtonElement>("back");
  const error = byId("error");
  const insecure = byId("insecure");
  let t: Record<string, string> = {};
  let current: string | undefined;
  let busy = false;

  const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
  const host = (origin: string) => {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  };

  function show(id: string) {
    for (const section of sections) section.hidden = section.id !== id;
    const focus = byId(id).querySelector<HTMLElement>("input, button.primary");
    focus?.focus();
  }

  /** Plain HTTP away from this computer; mirrors warnsInsecure in server-address.ts. */
  function warnsInsecure(text: string) {
    const match = /^http:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(text.trim());
    return !!match && !/^(localhost|.+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(match[1]);
  }

  function setError(message: string | null, offerAnyway = false) {
    error.hidden = !message;
    error.textContent = message ?? "";
    anyway.hidden = !offerAnyway;
  }

  function showConnect(address?: string) {
    input.value = address ?? "";
    insecure.hidden = !warnsInsecure(input.value);
    back.hidden = !current;
    setError(null);
    show("connect");
    input.select();
  }

  function showCertificate(certificate: PageCertificate, afterTrust: () => void, onBack: () => void) {
    byId("certificate-body").textContent = fill(t.certBody, { host: certificate.host });
    byId("certificate-fingerprint").textContent = certificate.fingerprint;
    byId("certificate-detail").textContent = [certificate.subject, certificate.issuer, certificate.validUntil.slice(0, 10), certificate.error]
      .filter(Boolean)
      .join(" · ");
    byId<HTMLButtonElement>("certificate-trust").onclick = async () => {
      const { ok } = await bridge.trust(certificate.host, certificate.fingerprint);
      if (ok) afterTrust();
      else onBack();
    };
    byId<HTMLButtonElement>("certificate-back").onclick = onBack;
    show("certificate");
  }

  async function submit(force: boolean) {
    if (busy) return;
    const address = input.value;
    busy = true;
    connectButton.disabled = anyway.disabled = true;
    connectButton.textContent = t.connecting;
    setError(null);
    try {
      const reply = await bridge.connect(address, force);
      if ("ok" in reply) return; // The window moves on to the server.
      if (reply.error === "invalid") setError(t.errorInvalid);
      else if (reply.error === "unreachable") setError(fill(t.errorUnreachable, { host: reply.host }));
      else if (reply.error === "not-leafdesk") setError(fill(t.errorNotLeafdesk, { host: reply.host }), true);
      else
        showCertificate(
          reply.certificate,
          () => {
            show("connect");
            void submit(force);
          },
          () => showConnect(address),
        );
    } finally {
      busy = false;
      connectButton.disabled = anyway.disabled = false;
      connectButton.textContent = t.connect;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit(false);
  });
  anyway.addEventListener("click", () => void submit(true));
  back.addEventListener("click", () => void bridge.retry());
  input.addEventListener("input", () => {
    insecure.hidden = !warnsInsecure(input.value);
    setError(null);
  });
  byId("problem-retry").addEventListener("click", () => void bridge.retry());
  byId("local-start").addEventListener("click", () => void bridge.startLocal());

  void bridge.state().then((state) => {
    t = state.strings;
    current = state.current;
    document.documentElement.lang = state.locale;
    document.documentElement.dir = state.dir;
    for (const element of document.querySelectorAll<HTMLElement>("[data-text]")) {
      element.textContent = t[element.dataset.text ?? ""] ?? "";
    }

    if (state.localAvailable) {
      byId("local-mode").classList.remove("unavailable");
      byId("local-mode").removeAttribute("aria-disabled");
      byId("local-soon").hidden = true;
      byId("local-actions").hidden = false;
    }

    if (state.view === "connect") return showConnect(state.address);
    if (state.view === "starting") return show("starting");
    const server = state.server;
    byId("problem-change").onclick = () => showConnect(server);
    if (state.certificate) {
      return showCertificate(
        state.certificate,
        () => void bridge.retry(),
        () => showConnect(server),
      );
    }
    byId("problem-title").textContent = state.local ? t.localProblemTitle : fill(t.problemTitle, { host: host(server) });
    byId("problem-body").textContent = state.local ? t.localProblemBody : t.problemBody;
    byId("problem-detail").textContent = state.detail;
    show("problem");
  });
}
