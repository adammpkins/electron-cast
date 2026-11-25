// A small XML reader for the two documents DIAL devices serve (the UPnP device description and the app info).
// It stands in for Chromium's out-of-process XML parser (services/data_decoder, used by SafeDialDeviceDescriptionParser
// and SafeDialAppInfoParser) and keeps the same view of a document: elements by local name, attributes, and the
// first text or CDATA child as an element's text, with whitespace-only text dropped (WhitespaceBehavior::kIgnore).
// It reads data only: no DTD or entity definitions are honoured, so there is nothing to expand.

export interface XmlElement {
  /** The local name: any namespace prefix is dropped. */
  name: string;
  attributes: Record<string, string>;
  /** Child elements, in document order. */
  children: XmlElement[];
  /** The first text or CDATA child's text, or null when the element has none. */
  text: string | null;
}

const MAX_DEPTH = 64;
const NAME_START = /[A-Za-z_:\u00C0-\uFFFF]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-\u00B7\u00C0-\uFFFF]/;

const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g;

/** Resolves the five predefined entities and character references; null for anything else containing "&". */
function decodeEntities(raw: string): string | null {
  if (!raw.includes("&")) return raw;
  if (raw.replace(ENTITY, "").includes("&")) return null;
  let ok = true;
  const out = raw.replace(ENTITY, (_whole, body: string) => {
    switch (body) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "apos": return "'";
    }
    if (body.startsWith("#")) {
      const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        return String.fromCodePoint(code);
      }
    }
    ok = false;
    return "";
  });
  return ok ? out : null;
}

function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** Parses a document and returns its root element, or null when it is not well-formed. */
export function parseXml(source: string): XmlElement | null {
  let src = source;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  let i = 0;
  const n = src.length;
  let root: XmlElement | null = null;
  const stack: XmlElement[] = [];
  const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

  const readName = (): string | null => {
    const first = src[i];
    if (first === undefined || !NAME_START.test(first)) return null;
    const start = i++;
    while (i < n && NAME_CHAR.test(src[i]!)) i++;
    return src.slice(start, i);
  };
  const skipSpace = (): void => {
    while (i < n && isSpace(src[i]!)) i++;
  };

  while (i < n) {
    if (src[i] !== "<") {
      const end = src.indexOf("<", i);
      const raw = src.slice(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      const top = stack[stack.length - 1];
      if (top === undefined) {
        if (raw.trim() !== "") return null;
        continue;
      }
      if (raw.trim() === "") continue;
      const text = decodeEntities(raw);
      if (text === null) return null;
      if (top.text === null) top.text = text;
      continue;
    }
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end === -1) return null;
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      const top = stack[stack.length - 1];
      const end = src.indexOf("]]>", i + 9);
      if (top === undefined || end === -1) return null;
      if (top.text === null) top.text = src.slice(i + 9, end);
      i = end + 3;
    } else if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end === -1) return null;
      i = end + 2;
    } else if (src.startsWith("<!", i)) {
      // A DOCTYPE is skipped; one that declares entities is refused rather than half-honoured.
      if (!/^<!DOCTYPE/i.test(src.slice(i, i + 9)) || stack.length > 0 || root !== null) return null;
      let depth = 0;
      let j = i + 2;
      for (; j < n; j++) {
        const c = src[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      if (j >= n || /<!ENTITY/i.test(src.slice(i, j))) return null;
      i = j + 1;
    } else if (src.startsWith("</", i)) {
      i += 2;
      const name = readName();
      if (name === null) return null;
      skipSpace();
      if (src[i] !== ">") return null;
      i++;
      const open = stack.pop();
      if (open === undefined || open.name !== localName(name)) return null;
    } else {
      i++;
      const rawName = readName();
      if (rawName === null) return null;
      const element: XmlElement = { name: localName(rawName), attributes: {}, children: [], text: null };
      let selfClosing = false;
      for (;;) {
        const before = i;
        skipSpace();
        const c = src[i];
        if (c === undefined) return null;
        if (c === ">") {
          i++;
          break;
        }
        if (c === "/") {
          if (src[i + 1] !== ">") return null;
          i += 2;
          selfClosing = true;
          break;
        }
        if (i === before) return null;
        const attr = readName();
        if (attr === null) return null;
        skipSpace();
        if (src[i] !== "=") return null;
        i++;
        skipSpace();
        const quote = src[i];
        if (quote !== "\"" && quote !== "'") return null;
        const close = src.indexOf(quote, i + 1);
        if (close === -1) return null;
        const value = decodeEntities(src.slice(i + 1, close));
        if (value === null || src.slice(i + 1, close).includes("<")) return null;
        i = close + 1;
        const key = attr.startsWith("xmlns") ? null : localName(attr);
        if (key !== null && !(key in element.attributes)) element.attributes[key] = value;
      }
      const parent = stack[stack.length - 1];
      if (parent !== undefined) parent.children.push(element);
      else if (root === null) root = element;
      else return null;
      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) return null;
        stack.push(element);
      }
    }
  }
  return stack.length === 0 ? root : null;
}

/** The direct children named `name`. */
export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((c) => c.name === name);
}
