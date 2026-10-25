import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as utils from "../public/library-utils.js";
import { loadLibrarySnapshot } from "../public/library-loader.js";
import { sendLibraryAction, refreshAfterActionError } from "../public/library-action-client.js";

function element() {
  const children = new Map();
  const classes = new Set();
  const attributes = new Map();
  return {
    hidden: true, textContent: "", disabled: false, dataset: {}, isConnected: true,
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) { const enabled = force ?? !classes.has(name); if (enabled) classes.add(name); else classes.delete(name); return enabled; },
    },
    style: { removeProperty() {}, setProperty() {} },
    querySelector(selector) { if (!children.has(selector)) children.set(selector, element()); return children.get(selector); },
    addEventListener() {}, setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); }, removeAttribute(name) { attributes.delete(name); },
    replaceChildren() {}, append() {}, focus() {}, scrollIntoView() {},
    contains() { return false; },
  };
}

// Execute the real app module against a small DOM substitute; no browser or service access.
export async function appHarness(fetchImpl) {
  const elements = new Map();
  const getElement = selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
  const source = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/^initialize\(\);$/m, "");
  const context = vm.createContext({
    ...utils, loadLibrarySnapshot, sendLibraryAction, refreshAfterActionError,
    fetch: fetchImpl, URL, URLSearchParams,
    setTimeout: () => 1, clearTimeout() {}, setInterval() {}, requestAnimationFrame() {},
    document: { querySelector: getElement, querySelectorAll: () => [], createElement: element,
      createDocumentFragment: element, addEventListener() {}, body: element() },
    window: { location: { pathname: "/movies", search: "", href: "http://cleanerr.local/movies" },
      innerWidth: 1200, addEventListener() {}, scrollTo() {}, history: {} },
  });
  vm.runInContext(`${source}\nglobalThis.app = {
    loadLibrary, invalidateLibrary, saveServiceSettings, createSeasonItem, renderSeasonAvailability,
    snapshot: () => ({ libraryItems, collectionItems, configurationRevision }),
    setSettings: value => { settingsState = value; },
  };`, context);
  return { ...context.app, getElement };
}
