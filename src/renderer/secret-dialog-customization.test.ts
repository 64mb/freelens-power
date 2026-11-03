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
