// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { startSecretDialogCustomization } from "./secret-dialog-customization";

it("adds one native icon while preserving submit behavior, input values and validation", async () => {
  document.body.innerHTML =
    '<div class="AddSecretDialog"><form class="WizardStep"><input required value="neutral-example"><div class="buttons"><button type="submit" class="Button">Create</button></div></form></div><button type="submit">Other</button>';
  const submit = vi.fn((event: Event) => event.preventDefault());
  document.querySelector("form")!.addEventListener("submit", submit);
  const stop = startSecretDialogCustomization();
  expect(document.querySelectorAll(".power-secret-create-icon")).toHaveLength(1);
  expect(document.querySelector<HTMLInputElement>("input")!.value).toBe("neutral-example");
  expect(document.querySelector<HTMLInputElement>("input")!.required).toBe(true);
  document.querySelector<HTMLButtonElement>(".AddSecretDialog button")!.click();
  expect(submit).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(document.querySelectorAll(".power-secret-create-icon")).toHaveLength(1);
  stop();
  expect(document.querySelector(".power-secret-create-icon")).toBeNull();
  expect(document.querySelector(".AddSecretDialog button")!.textContent).toBe("Create");
  document.body.innerHTML = "";
});

it.each([
  "AddNamespaceDialog",
  "AddQuotaDialog",
  "AddRoleDialog",
  "AddClusterRoleDialog",
  "AddRoleBindingDialog",
  "AddClusterRoleBindingDialog",
  "CreateServiceAccountDialog",
])("adds the native Create icon only in the audited %s dialog", (name) => {
  document.body.innerHTML = `<div class="${name}"><form class="WizardStep"><input required value="neutral-example"><label><input type="checkbox">Native warning</label><div class="buttons"><button type="submit" class="Button">Create</button></div></form></div><div class="UnknownDialog"><form class="WizardStep"><div class="buttons"><button type="submit" class="Button">Create</button></div></form></div>`;
  const stop = startSecretDialogCustomization();
  expect(document.querySelectorAll(".power-secret-create-icon")).toHaveLength(1);
  expect(document.querySelector(`.${name} input[required]`)).toBeTruthy();
  expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  expect(document.querySelector(".UnknownDialog .power-secret-create-icon")).toBeNull();
  stop();
  document.body.innerHTML = "";
});

it("preserves Update actions and namespace name confirmations", () => {
  document.body.innerHTML =
    '<div class="AddRoleBindingDialog"><form class="WizardStep"><div class="buttons"><button type="submit" class="Button">Update</button></div></form></div><div class="DeleteNamespaceDialog"><input required placeholder="Type namespace name"><label><input type="checkbox">Delete contained resources</label><button>Delete</button></div>';
  const original = document.querySelector(".DeleteNamespaceDialog")!.innerHTML;
  const stop = startSecretDialogCustomization();
  expect(document.querySelector(".power-secret-create-icon")).toBeNull();
  expect(document.querySelector(".DeleteNamespaceDialog")!.innerHTML).toBe(original);
  stop();
  document.body.innerHTML = "";
});

it.each(["AddSecretDialog", "AddNamespaceDialog"])("sizes the native v2 %s content wrapper", (name) => {
  document.body.innerHTML = `<div class="Dialog modal ${name}"><div class="dialog-content"><div class="Wizard"><div class="header"><h5>Create resource</h5></div><form class="WizardStep"><div class="buttons"><button type="submit" class="Button">Create</button></div></form></div></div></div>`;
  const stop = startSecretDialogCustomization();
  const panel = document.querySelector<HTMLElement>(".Dialog > .dialog-content")!;
  expect(getComputedStyle(panel).width).toContain(name === "AddSecretDialog" ? "720px" : "640px");
  expect(getComputedStyle(panel.querySelector(".Wizard")!).width).toBe("100%");
  stop();
  document.body.innerHTML = "";
});

it("keeps the audited v2 flex-column creation fields fourteen pixels apart and labels six pixels from controls", () => {
  document.body.innerHTML =
    '<style>.gap-2 { gap:8px; }</style><div class="Dialog AddRoleDialog"><div class="dialog-content"><div class="Wizard"><form class="WizardStep"><div class="step-content flex gap-2 flex-col"><div class="SubTitle">Name</div><input id="role-name" required /><div class="SubTitle" id="next-label">Namespace</div><input id="namespace-name" /></div></form></div></div></div>';
  const stop = startSecretDialogCustomization();
  expect(getComputedStyle(document.querySelector(".step-content")!).gap).toBe("0px");
  expect(getComputedStyle(document.querySelector("#role-name")!).marginTop).toBe("6px");
  expect(getComputedStyle(document.querySelector("#next-label")!).marginTop).toBe("14px");
  expect(getComputedStyle(document.querySelector("#next-label")!).marginBottom).toBe("0px");
  expect(document.querySelector<HTMLInputElement>("#role-name")!.required).toBe(true);
  stop();
  document.body.innerHTML = "";
});

it("uses one sixteen-pixel gap for v2 Secret groups without stacking native space-y margins", () => {
  document.body.innerHTML =
    '<style>.space-y-3 > * { margin-block:0 12px; }</style><div class="Dialog AddSecretDialog"><div class="dialog-content"><div class="Wizard"><form class="WizardStep"><div class="step-content space-y-3"><div class="secret-name">Name</div><div class="flex gap-3">Namespace and type</div></div></form></div></div></div>';
  const stop = startSecretDialogCustomization();
  const content = document.querySelector(".step-content")!;
  expect(getComputedStyle(content).display).toBe("flex");
  expect(getComputedStyle(content).flexDirection).toBe("column");
  expect(getComputedStyle(content).gap).toBe("16px");
  expect(Number.parseFloat(getComputedStyle(content.firstElementChild!).marginBlockEnd)).toBe(0);
  stop();
  document.body.innerHTML = "";
});
