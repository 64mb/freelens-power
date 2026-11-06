export interface BulkSelectableNode {
  uid: string;
  name: string;
}

export interface NodeBulkSelectionOptions {
  getNodes: () => readonly BulkSelectableNode[];
  getContext?: () => string;
  onChange: (nodes: BulkSelectableNode[]) => void;
  onTable?: (table: HTMLElement | null) => void;
}

const rowIdPrefix = "menu-actions-for-kube-object-menu-for-";
const marker = "data-power-node-selection";

/** adds selection for the currently rendered native node rows */
export function startNodeBulkSelection(options: NodeBulkSelectionOptions): {
  stop: () => void;
  clear: () => void;
  refresh: () => void;
} {
  const style = document.createElement("style");
  style.dataset.powerNodeSelection = "";
  style.textContent = `
    [${marker}] input:focus-visible ~ .check-icon { outline: 2px solid var(--blue); outline-offset: 3px; }
    [${marker}] .Checkbox.mixed > .check-icon:after {
      opacity: 1; top: 50%; left: 20%; width: 60%; height: 0;
      border: 0; border-top: 2px solid currentColor; transform: translateY(-50%);
    }
  `;
  document.head.append(style);
  const cells = new Map<HTMLElement, HTMLElement>();
  let selected = new Map<string, BulkSelectableNode>();
  let table: HTMLElement | null = null;
  let context = options.getContext?.();
  let stopped = false;
  let queued = false;
  let previous = "";
  const filterSignature = () => {
    const root = table?.closest(".Nodes");
    return JSON.stringify([
      window.location.pathname,
      window.location.search,
      window.location.hash,
      [
        ...(root?.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input:not([type=checkbox]), select") ?? []),
      ].map((input) => input.value),
      [...(root?.querySelectorAll(".PageFiltersList .filter") ?? [])].map((filter) => [
        filter.getAttribute("title"),
        filter.querySelector(".value")?.textContent,
      ]),
    ]);
  };
  let filters = "";
  const emit = () => {
    const value = [...selected.values()];
    const signature = JSON.stringify(value);
    if (signature === previous) return;
    previous = signature;
    options.onChange(value);
  };
  const removeCells = () => {
    for (const cell of cells.values()) cell.remove();
    cells.clear();
  };
  const createCell = (row: HTMLElement, label: string) => {
    let cell = cells.get(row);
    if (!cell || cell.parentElement !== row) {
      cell?.remove();
      cell = document.createElement("div");
      cell.className = "TableCell checkbox";
      cell.setAttribute(marker, "");
      cell.style.cssText = "flex:0 0 40px;width:40px;display:flex;align-items:center;justify-content:center";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.style.cssText =
        "display:block;position:absolute;opacity:0;width:100%;height:100%;z-index:1;margin:0;cursor:pointer";
      const checkbox = document.createElement("label");
      checkbox.className = "Checkbox flex items-center";
      checkbox.style.position = "relative";
      const box = document.createElement("i");
      box.className = "check-icon flex items-center";
      box.setAttribute("aria-hidden", "true");
      checkbox.append(input, box);
      cell.append(checkbox);
      cell.addEventListener("click", (event) => event.stopPropagation());
      cell.addEventListener("keydown", (event) => event.stopPropagation());
      cell.addEventListener("pointerdown", (event) => event.stopPropagation());
      row.prepend(cell);
      cells.set(row, cell);
    }
    const input = cell.querySelector("input") as HTMLInputElement;
    input.setAttribute("aria-label", label);
    return input;
  };
  const sync = () => {
    queued = false;
    if (stopped) return;
    const nextTable = document.querySelector<HTMLElement>(".Nodes .Table");
    const nextContext = options.getContext?.();
    if (nextTable !== table || nextContext !== context) {
      removeCells();
      selected.clear();
      context = nextContext;
      table = nextTable;
      options.onTable?.(table);
    }
    const nextFilters = filterSignature();
    if (nextFilters !== filters) {
      selected.clear();
      filters = nextFilters;
    }
    const nodes = new Map(
      options
        .getNodes()
        .filter((node) => node.uid && node.name)
        .map((node) => [node.uid, node]),
    );
    const rows = new Map<HTMLElement, BulkSelectableNode>();
    for (const row of table?.querySelectorAll<HTMLElement>(".TableRow[id]") ?? []) {
      if (!row.id.startsWith(rowIdPrefix)) continue;
      const node = nodes.get(row.id.slice(rowIdPrefix.length));
      if (node) rows.set(row, node);
    }
    const visible = new Map([...rows.values()].map((node) => [node.uid, node]));
    selected = new Map(
      [...selected.keys()].flatMap((uid) => {
        const node = nodes.get(uid);
        return node ? [[uid, node] as const] : [];
      }),
    );
    const header = table?.querySelector<HTMLElement>(".TableHead");
    for (const [row, cell] of cells) {
      if (!rows.has(row) && row !== header) {
        cell.remove();
        cells.delete(row);
      }
    }
    for (const [row, node] of rows) {
      const input = createCell(row, `Select node ${node.name}`);
      input.checked = selected.has(node.uid);
      input.onchange = () => {
        // resolve identity again because virtual rows can be reused before mutation delivery
        const uid = row.id.startsWith(rowIdPrefix) ? row.id.slice(rowIdPrefix.length) : "";
        const current = options.getNodes().find((item) => item.uid === uid);
        if (!current) return sync();
        if (input.checked) selected.set(uid, current);
        else selected.delete(uid);
        sync();
      };
    }
    if (header) {
      const input = createCell(header, "Select visible nodes");
      input.disabled = visible.size === 0;
      const visibleSelected = [...visible.keys()].filter((uid) => selected.has(uid)).length;
      input.checked = visible.size > 0 && visibleSelected === visible.size;
      input.indeterminate = visibleSelected > 0 && visibleSelected < visible.size;
      input.setAttribute("aria-checked", input.indeterminate ? "mixed" : String(input.checked));
      input.parentElement?.classList.toggle("mixed", input.indeterminate);
      input.onchange = () => {
        const checked = input.checked;
        // refresh the rendered inventory before selecting after a virtual scroll
        sync();
        const renderedIds = new Set(
          [...(table?.querySelectorAll<HTMLElement>(".TableRow[id]") ?? [])].map((row) =>
            row.id.slice(rowIdPrefix.length),
          ),
        );
        for (const node of options.getNodes()) {
          if (!renderedIds.has(node.uid)) continue;
          if (checked) selected.set(node.uid, node);
          else selected.delete(node.uid);
        }
        sync();
      };
    }
    emit();
  };
  const filterChanged = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type === "checkbox" || !target.closest(".Nodes")) return;
    selected.clear();
    sync();
  };
  const checkFilters = () => {
    if (!stopped && filterSignature() !== filters) sync();
  };
  // native search clear and history updates can change values without DOM input events
  const filterTimer = window.setInterval(checkFilters, 100);
  window.addEventListener("popstate", checkFilters);
  window.addEventListener("hashchange", checkFilters);
  document.addEventListener("click", checkFilters, true);
  document.addEventListener("keydown", checkFilters, true);
  document.addEventListener("input", filterChanged);
  document.addEventListener("change", filterChanged);
  const observer = new MutationObserver(() => {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(sync);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
    attributeFilter: ["id", "class", "value", "title"],
  });
  sync();
  return {
    refresh: sync,
    clear: () => {
      selected.clear();
      sync();
    },
    stop: () => {
      stopped = true;
      observer.disconnect();
      window.clearInterval(filterTimer);
      window.removeEventListener("popstate", checkFilters);
      window.removeEventListener("hashchange", checkFilters);
      document.removeEventListener("click", checkFilters, true);
      document.removeEventListener("keydown", checkFilters, true);
      style.remove();
      document.removeEventListener("input", filterChanged);
      document.removeEventListener("change", filterChanged);
      removeCells();
      selected.clear();
      emit();
      options.onTable?.(null);
    },
  };
}
