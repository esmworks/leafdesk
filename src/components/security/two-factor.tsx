"use client";

import { Download } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { SettingsRow } from "@/components/settings/section";
import { CopyButton } from "@/components/settings/copy-button";
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Input } from "@/components/ui";
import { authClient } from "@/lib/auth-client";
import { securityErrorKey } from "@/lib/auth-errors";
import { QrCode } from "./qr-code";

type AuthError = { code?: string | null; status?: number } | null | undefined;

/** Turns a Better Auth error into a sentence, or null when there is nothing to say. */
export function useSecurityError() {
  const t = useTranslations("security.errors");
  return (error: AuthError) => {
    const key = securityErrorKey(error);
    return key ? t(key) : null;
  };
}

/** The base32 key inside the authenticator URI, in groups of four for typing by hand. */
function manualKey(totpURI: string) {
  const secret = new URL(totpURI).searchParams.get("secret") ?? "";
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}

/** A six-digit code field; recovery codes (`xxxxx-xxxxx`) when `recovery` is set. */
export function CodeInput({
  id,
  recovery,
  ...props
}: { id: string; recovery?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Input
      id={id}
      name="code"
      required
      autoComplete="one-time-code"
      inputMode={recovery ? "text" : "numeric"}
      pattern={recovery ? undefined : "[0-9 ]{6,7}"}
      maxLength={recovery ? 32 : 7}
      spellCheck={false}
      className="tracking-widest tabular-nums"
      {...props}
    />
  );
}

/** Recovery codes, shown once: copy or download them before closing. */
export function RecoveryCodes({ codes }: { codes: string[] }) {
  const t = useTranslations("security.recoveryCodes");
  const text = codes.join("\n");
  return (
    <div className="space-y-3">
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-border bg-bg-subtle px-4 py-3 font-mono text-sm tabular-nums">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton value={text} label={t("copy")} />
        <Button
          size="sm"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([`${t("fileHeading")}\n\n${text}\n`], { type: "text/plain" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = "leafdesk-recovery-codes.txt";
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download className="h-3.5 w-3.5" />
          {t("download")}
        </Button>
      </div>
    </div>
  );
}

type SetupStep =
  | { name: "start" }
  | { name: "scan"; totpURI: string; backupCodes: string[] }
  | { name: "codes"; backupCodes: string[] };

/**
 * Turning on the authenticator app: confirm with the password (when the account has one), scan
 * the QR code or type the key, prove it works with a code, then keep the recovery codes.
 * Used in Settings and on the page a workspace requiring two-step verification sends people to.
 */
export function TwoFactorSetupFlow({
  hasPassword,
  onDone,
  onCancel,
}: {
  hasPassword: boolean;
  /** After the recovery codes were shown and acknowledged. */
  onDone: () => void;
  onCancel?: () => void;
}) {
  const t = useTranslations("security.twoFactor");
  const tf = useTranslations("security.fields");
  const tc = useTranslations("common");
  const describe = useSecurityError();
  const [step, setStep] = useState<SetupStep>({ name: "start" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(form: FormData) {
    setPending(true);
    setError(null);
    const password = hasPassword ? String(form.get("password") ?? "") : undefined;
    const result = await authClient.twoFactor.enable({ password });
    setPending(false);
    if (result.error || !result.data || !("totpURI" in result.data) || !result.data.totpURI) {
      return setError(describe(result.error) ?? describe({ code: "UNKNOWN" }));
    }
    setStep({ name: "scan", totpURI: result.data.totpURI, backupCodes: result.data.backupCodes ?? [] });
  }

  async function verify(form: FormData, backupCodes: string[]) {
    setPending(true);
    setError(null);
    const code = String(form.get("code") ?? "").replace(/\s+/g, "");
    const result = await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (result.error) return setError(describe(result.error));
    setStep({ name: "codes", backupCodes });
  }

  const actions = (submit: React.ReactNode) => (
    <div className="flex justify-end gap-2">
      {onCancel && (
        <Button variant="ghost" onClick={onCancel}>
          {tc("cancel")}
        </Button>
      )}
      {submit}
    </div>
  );

  if (step.name === "start") {
    return (
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void start(new FormData(e.currentTarget));
        }}
      >
        <p className="text-sm text-fg-muted">{t("intro")}</p>
        {hasPassword && (
          <label className="block space-y-1.5">
            <span className="text-sm text-fg-muted">{tf("password")}</span>
            <Input name="password" type="password" required autoComplete="current-password" autoFocus />
          </label>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        {actions(
          <Button type="submit" variant="primary" disabled={pending}>
            {t("continue")}
          </Button>,
        )}
      </form>
    );
  }

  if (step.name === "scan") {
    return (
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void verify(new FormData(e.currentTarget), step.backupCodes);
        }}
      >
        <p className="text-sm text-fg-muted">{t("scan")}</p>
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <QrCode value={step.totpURI} label={t("qrLabel")} />
          <div className="min-w-0 space-y-1.5 text-sm">
            <p className="text-fg-muted">{t("manualKey")}</p>
            <p className="font-mono text-sm break-all tabular-nums">{manualKey(step.totpURI)}</p>
            <CopyButton value={manualKey(step.totpURI).replaceAll(" ", "")} label={t("copyKey")} />
          </div>
        </div>
        <label htmlFor="setup-code" className="block space-y-1.5">
          <span className="text-sm text-fg-muted">{t("codeLabel")}</span>
          <CodeInput id="setup-code" autoFocus />
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
        {actions(
          <Button type="submit" variant="primary" disabled={pending}>
            {t("verify")}
          </Button>,
        )}
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm font-medium">{t("enabledTitle")}</p>
      <p className="text-sm text-fg-muted">{t("codesIntro")}</p>
      <RecoveryCodes codes={step.backupCodes} />
      <div className="flex justify-end">
        <Button variant="primary" onClick={onDone}>
          {t("savedCodes")}
        </Button>
      </div>
    </div>
  );
}

/** New recovery codes replace the old ones; the password confirms it when the account has one. */
function RegenerateCodesDialog({ hasPassword, onClose }: { hasPassword: boolean; onClose: () => void }) {
  const t = useTranslations("security.recoveryCodes");
  const tf = useTranslations("security.fields");
  const tc = useTranslations("common");
  const describe = useSecurityError();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open onClose={codes ? () => {} : onClose} className="max-w-md">
      {codes ? (
        <>
          <DialogBody className="pt-5">
            <div className="space-y-1.5">
              <DialogTitle>{t("regenerateTitle")}</DialogTitle>
              <p className="text-sm text-fg-muted">{t("newCodes")}</p>
            </div>
            <RecoveryCodes codes={codes} />
          </DialogBody>
          <DialogFooter>
            <Button variant="primary" onClick={onClose}>
              {tc("close")}
            </Button>
          </DialogFooter>
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setPending(true);
            setError(null);
            const password = hasPassword ? String(new FormData(e.currentTarget).get("password") ?? "") : undefined;
            const result = await authClient.twoFactor.generateBackupCodes({ password });
            setPending(false);
            if (result.error || !result.data) return setError(describe(result.error));
            setCodes(result.data.backupCodes);
          }}
        >
          <DialogBody className="pt-5">
            <div className="space-y-1.5">
              <DialogTitle>{t("regenerateTitle")}</DialogTitle>
              <p className="text-sm text-fg-muted">{t("regenerateBody")}</p>
            </div>
            {hasPassword && (
              <label className="block space-y-1.5">
                <span className="text-sm text-fg-muted">{tf("password")}</span>
                <Input name="password" type="password" required autoComplete="current-password" autoFocus />
              </label>
            )}
            {error && <p className="text-sm text-danger">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {t("regenerate")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

/**
 * Turning it off asks for the password, or for accounts without one (GitHub/Google only) a code
 * from the app or a recovery code; the server checks either (see requireCodeToDisable).
 */
function DisableDialog({ hasPassword, onClose, onDone }: { hasPassword: boolean; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("security.twoFactor");
  const tf = useTranslations("security.fields");
  const tc = useTranslations("common");
  const describe = useSecurityError();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          const form = new FormData(e.currentTarget);
          const result = hasPassword
            ? await authClient.twoFactor.disable({ password: String(form.get("password") ?? "") })
            : await authClient.$fetch("/two-factor/disable", {
                method: "POST",
                body: { code: String(form.get("code") ?? "").trim() },
              });
          setPending(false);
          if (result.error) return setError(describe(result.error));
          onDone();
        }}
      >
        <DialogBody className="pt-5">
          <div className="space-y-1.5">
            <DialogTitle>{t("disableTitle")}</DialogTitle>
            <p className="text-sm text-fg-muted">{t("disableBody")}</p>
          </div>
          {hasPassword ? (
            <label className="block space-y-1.5">
              <span className="text-sm text-fg-muted">{tf("password")}</span>
              <Input name="password" type="password" required autoComplete="current-password" autoFocus />
            </label>
          ) : (
            <label htmlFor="disable-code" className="block space-y-1.5">
              <span className="text-sm text-fg-muted">{t("disableCodeLabel")}</span>
              <CodeInput id="disable-code" recovery autoFocus />
            </label>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="danger" disabled={pending}>
            {t("disable")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Settings > Account security: the authenticator app and its recovery codes. */
export function TwoFactorSettings({ enabled, hasPassword }: { enabled: boolean; hasPassword: boolean }) {
  const t = useTranslations("security.twoFactor");
  const tr = useTranslations("security.recoveryCodes");
  const router = useRouter();
  const [dialog, setDialog] = useState<"setup" | "disable" | "codes" | null>(null);
  const close = () => setDialog(null);
  const done = () => {
    setDialog(null);
    router.refresh();
  };

  return (
    <>
      <SettingsRow
        title={t("title")}
        description={enabled ? t("on") : t("off")}
        control={
          enabled ? (
            <Button onClick={() => setDialog("disable")}>{t("disable")}</Button>
          ) : (
            <Button variant="primary" onClick={() => setDialog("setup")}>
              {t("setUp")}
            </Button>
          )
        }
      />
      {enabled && (
        <SettingsRow
          title={tr("title")}
          description={tr("description")}
          control={<Button onClick={() => setDialog("codes")}>{tr("regenerate")}</Button>}
        />
      )}
      {dialog === "setup" && (
        // Closing by clicking outside would lose the recovery codes; only the buttons close it.
        <Dialog open onClose={() => {}} className="max-w-lg">
          <DialogBody className="pt-5">
            <DialogTitle>{t("setupTitle")}</DialogTitle>
            <TwoFactorSetupFlow hasPassword={hasPassword} onCancel={close} onDone={done} />
          </DialogBody>
        </Dialog>
      )}
      {dialog === "disable" && <DisableDialog hasPassword={hasPassword} onClose={close} onDone={done} />}
      {dialog === "codes" && <RegenerateCodesDialog hasPassword={hasPassword} onClose={done} />}
    </>
  );
}
