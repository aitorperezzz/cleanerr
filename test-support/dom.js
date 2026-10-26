export function element() {
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

