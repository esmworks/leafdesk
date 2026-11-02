import { getTranslations } from "next-intl/server";
import { Ban, Inbox, Layers } from "lucide-react";
import { SettingsGroup } from "@/components/settings/section";
import { isDomainRule } from "@/lib/mail-senders";
import { listSenderRules } from "@/server/mail-client/senders";
import { SenderRuleRemove } from "./sender-rule-remove";

/**
 * Account > Mail: where the person's inboxes put each sender's mail (server/mail-client/senders.ts),
 * Focus or Other, and the addresses they blocked, each with a way to stop. Rules are made from a
 * conversation's menu in Mail.
 */
export async function SenderRules({ userId }: { userId: string }) {
  const [rules, t] = await Promise.all([listSenderRules(userId), getTranslations("account.mail")]);
  const label = { focus: t("senderRuleFocus"), other: t("senderRuleOther"), block: t("senderRuleBlock") };
  const Icon = { focus: Inbox, other: Layers, block: Ban };
  return (
    <SettingsGroup anchor="senderRules" title={t("senderRulesHeading")} description={t("senderRulesDescription")}>
      {rules.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-fg-muted">{t("senderRulesEmpty")}</p>
      ) : (
        rules.map((rule) => {
          const RuleIcon = Icon[rule.kind];
          return (
            <div key={rule.sender} className="flex items-center gap-3 px-5 py-3">
              <RuleIcon className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{isDomainRule(rule.sender) ? `@${rule.sender}` : rule.sender}</div>
                <div className="truncate text-xs text-fg-muted">
                  {label[rule.kind]}
                  {isDomainRule(rule.sender) && ` · ${t("senderRuleEveryone")}`}
                </div>
              </div>
              <SenderRuleRemove sender={rule.sender} />
            </div>
          );
        })
      )}
    </SettingsGroup>
  );
}
