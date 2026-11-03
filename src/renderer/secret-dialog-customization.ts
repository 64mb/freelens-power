export const nativeCreationDialogClasses = [
  "AddSecretDialog",
  "AddNamespaceDialog",
  "AddQuotaDialog",
  "AddRoleDialog",
  "AddClusterRoleDialog",
  "AddRoleBindingDialog",
  "AddClusterRoleBindingDialog",
  "CreateServiceAccountDialog",
] as const;

const nativeCreationScope = `:is(${nativeCreationDialogClasses.map((name) => `.${name}`).join(",")})`;
const nativeCreationIcons: Record<(typeof nativeCreationDialogClasses)[number], string> = {
  AddSecretDialog: "vpn_key",
  AddNamespaceDialog: "layers",
  AddQuotaDialog: "pie_chart",
  AddRoleDialog: "supervisor_account",
  AddClusterRoleDialog: "admin_panel_settings",
  AddRoleBindingDialog: "link",
  AddClusterRoleBindingDialog: "link",
  CreateServiceAccountDialog: "account_circle",
};

export const secretDialogStyles = `
${nativeCreationScope} > .box { max-width: calc(100vw - 32px); width: min(640px,calc(100vw - 32px)); }
${nativeCreationScope} > .box > .Wizard { width: 100%; max-width: 100%; }
${nativeCreationScope} .Wizard > .header { padding:16px 24px; border-bottom:1px solid var(--borderColor); text-align:left; }
${nativeCreationScope} .Wizard > .header h5 { display:flex; align-items:center; gap:10px; margin:0; font-size:16px; font-weight:600; }
${nativeCreationScope} .power-create-resource-icon { --size:20px; color:var(--primary); pointer-events:none; }
${nativeCreationScope} .WizardStep .step-content { padding: 20px 24px; max-height: calc(100dvh - 210px); overflow-y: auto; min-width: 0; }
${nativeCreationScope} .WizardStep .step-content.flex.column { gap: 0; }
${nativeCreationScope} .WizardStep .step-content.flex.gaps.column > :not(:last-child) { margin-bottom: 0; }
${nativeCreationScope} .WizardStep .step-content.flex.column > :not(:first-child) { margin-top:14px; }
${nativeCreationScope} .WizardStep .step-content.flex.column > .SubTitle + * { margin-top:6px; }
${nativeCreationScope} .Input { min-width:0; }
${nativeCreationScope} .Input > .input-area { box-sizing:border-box; min-height:36px; padding:6px 10px; border:1px solid var(--borderColor); border-radius:4px; background:var(--contentColor); }
${nativeCreationScope} .Input > .input-area::after { display:none; }
${nativeCreationScope} .Input:not(.invalid) > .input-area:focus-within { border-color:var(--primary); }
${nativeCreationScope} .Input.invalid.dirty > .input-area { border-color:var(--colorError); }
${nativeCreationScope} .Input > .input-area textarea { min-height:24px; }
${nativeCreationScope} .SubTitle { margin-bottom: 6px; }
${nativeCreationScope} .Select { min-width: 0; }
${nativeCreationScope} .Select__control { box-sizing:border-box; min-height:36px; border:1px solid var(--borderColor); border-radius:4px; background:var(--contentColor); }
${nativeCreationScope} .Select__single-value, ${nativeCreationScope} .Select__input-container { color:var(--textColorPrimary); }
${nativeCreationScope} .Select__control:not(.Select__control--is-disabled):hover { border-color:var(--primary); }
${nativeCreationScope} .Select__control--is-focused { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
${nativeCreationScope} .WizardStep > .buttons { padding: 16px 24px; border-top: 1px solid var(--borderColor); }
${nativeCreationScope} .WizardStep > .buttons .Button { min-height:32px; border-radius:4px; }
${nativeCreationScope} .Button[type="submit"] { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
${nativeCreationScope} .power-secret-create-icon { --size: 18px; pointer-events: none; }
${nativeCreationScope} :is(input,textarea,button,[tabindex]):focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
@media(max-width:520px) {
  ${nativeCreationScope} .WizardStep .step-content { padding: 16px; }
  .AddQuotaDialog .step-content > .flex { flex-wrap: wrap; gap: 10px; }
  .AddQuotaDialog .step-content > .flex.gaps > :not(:last-child) { margin-right: 0; }
  .AddQuotaDialog .quota-select { flex-basis: 100%; }
  ${nativeCreationScope} .Input,${nativeCreationScope} .Select { min-width: 0; max-width: 100%; }
}

.AddSecretDialog > .box { width: min(720px,calc(100vw - 32px)); max-width: calc(100vw - 32px); }
.AddSecretDialog .WizardStep .step-content { gap: 16px; padding: 20px 24px; max-height: calc(100dvh - 210px); overflow-y: auto; }
.AddSecretDialog .secret-name,.AddSecretDialog .secret-namespace,.AddSecretDialog .secret-type { min-width: 0; }
.AddSecretDialog .secret-namespace,.AddSecretDialog .secret-type { flex: 1 1 0; }
.AddSecretDialog .SubTitle { margin-bottom: 6px; }
.AddSecretDialog .fields-title { display: flex; align-items: center; gap: 8px; margin: 8px 0 0; padding-top: 12px; border-top: 1px solid var(--borderColor); }
.AddSecretDialog .fields-title .Icon { --color-active: var(--primary); }
.AddSecretDialog .Select { min-width: 0; }
.AddSecretDialog .Select__control { border-color: var(--borderColor); }
.AddSecretDialog .Select__control--is-focused { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
.AddSecretDialog .secret-fields { display: flex; flex-direction: column; gap: 10px; }
.AddSecretDialog .secret-field { display: grid; grid-template-columns: minmax(120px,2fr) minmax(160px,3fr) 24px; align-items: start; gap: 10px; }
.AddSecretDialog .secret-field.flex.gaps > :not(:last-child) { margin-right: 0; margin-bottom: 0; }
.AddSecretDialog .secret-field .Input { min-width: 0; width: 100%; }
.AddSecretDialog .secret-field .value textarea { min-height: 36px; line-height: 1.5; resize: vertical; }
.AddSecretDialog .secret-field .remove-icon { margin-top: 8px; width: 24px; }
.AddSecretDialog .WizardStep > .buttons { padding: 16px 24px; border-top: 1px solid var(--borderColor); }
.AddSecretDialog .Button[type="submit"] { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.AddSecretDialog .power-secret-create-icon { --size: 18px; pointer-events: none; }
.AddSecretDialog :is(input,textarea,button,[tabindex]):focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
@media(max-width:520px) {
  .AddSecretDialog .WizardStep .step-content { padding: 16px; }
  .AddSecretDialog .secret-namespace,.AddSecretDialog .secret-type { flex-basis: 100%; }
  .AddSecretDialog .step-content > .flex { flex-wrap: wrap; }
  .AddSecretDialog .secret-field { grid-template-columns: minmax(0,1fr) 24px; }
  .AddSecretDialog .secret-field .key { grid-column: 1; }
  .AddSecretDialog .secret-field .value { grid-column: 1; grid-row: 2; }
  .AddSecretDialog .secret-field .remove-icon { grid-column: 2; grid-row: 1; }
}
`;

export function startSecretDialogCustomization(): () => void {
  const style = document.createElement("style");
  style.dataset.freelensPower = "secret-dialog";
  style.textContent = secretDialogStyles;
  document.head.append(style);
  const icons = new Set<HTMLElement>();
  const reconcile = () => {
    for (const icon of icons) if (!icon.isConnected) icons.delete(icon);
    for (const dialog of document.querySelectorAll<HTMLElement>(nativeCreationScope)) {
      const title = dialog.querySelector<HTMLElement>(".Wizard > .header h5");
      if (!title?.textContent?.trim().startsWith("Create") || title.querySelector(".power-create-resource-icon"))
        continue;
      const name = nativeCreationDialogClasses.find((name) => dialog.classList.contains(name));
      if (!name) continue;
      const icon = document.createElement("span");
      icon.className = "Icon material power-create-resource-icon";
      icon.setAttribute("aria-hidden", "true");
      const glyph = document.createElement("span");
      glyph.className = "icon";
      glyph.textContent = nativeCreationIcons[name];
      icon.append(glyph);
      title.prepend(icon);
      icons.add(icon);
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      `${nativeCreationScope} .WizardStep > .buttons .Button[type="submit"]`,
    )) {
      if (button.querySelector(".power-secret-create-icon") || button.textContent?.trim() !== "Create") continue;
      const icon = document.createElement("span");
      icon.className = "Icon material power-secret-create-icon";
      icon.setAttribute("aria-hidden", "true");
      const glyph = document.createElement("span");
      glyph.className = "icon";
      glyph.textContent = "add_circle_outline";
      icon.append(glyph);
      button.prepend(icon);
      icons.add(icon);
    }
  };
  reconcile();
  const observer = new MutationObserver(reconcile);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    for (const icon of icons) icon.remove();
    style.remove();
  };
}
