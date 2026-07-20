// Parse a Totescan MHTML export into structured Tote/Item records.
// Handles both raw HTML files and MIME/MHTML multipart containers.

export interface ParsedItem {
  itemNumber: number;
  name: string;
  quantity: number;
  description: string;
  upc: string;
  created: string;
  updated: string;
  imageUrls: string[];
}

export interface ParsedTote {
  toteId: string;
  title: string;
  location: string;
  profile: string;
  parentToteId: string;
  dateUpdated: string;
  items: ParsedItem[];
}

export interface EmbeddedPart {
  contentType: string;
  bytes: Uint8Array;
}

export type EmbeddedPartsMap = Map<string, EmbeddedPart>;

export interface ParseResult {
  totes: ParsedTote[];
  /** Non-HTML MIME parts keyed by Content-Location (the original absolute URL). */
  embedded: EmbeddedPartsMap;
}

export async function parseTotescanFile(file: File): Promise<ParseResult> {
  const raw = await file.text();
  if (looksLikeMime(raw)) {
    const { html, embedded } = extractFromMime(raw);
    return { totes: parseTotesFromHtml(html), embedded };
  }
  return { totes: parseTotesFromHtml(raw), embedded: new Map() };
}

function looksLikeMime(text: string): boolean {
  const head = text.slice(0, 2000).toLowerCase();
  return head.includes("mime-version:") || head.includes("content-type: multipart/");
}

function extractFromMime(raw: string): { html: string; embedded: EmbeddedPartsMap } {
  const embedded: EmbeddedPartsMap = new Map();
  let html = raw;
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  if (!boundaryMatch) return { html, embedded };
  const boundary = "--" + boundaryMatch[1];
  const parts = raw.split(boundary);
  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n") >= 0
      ? part.indexOf("\r\n\r\n") + 4
      : part.indexOf("\n\n") >= 0 ? part.indexOf("\n\n") + 2 : -1;
    if (headerEnd <= 0) continue;
    const headers = part.slice(0, headerEnd);
    let body = part.slice(headerEnd).replace(/\r?\n--\s*$/, "");
    const contentType = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim().toLowerCase() ?? "";
    const encoding = /content-transfer-encoding:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim().toLowerCase();
    const location = /content-location:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();

    if (contentType.startsWith("text/html")) {
      if (encoding === "quoted-printable") body = decodeQuotedPrintable(body);
      else if (encoding === "base64") body = atob(body.replace(/\s+/g, ""));
      html = body;
      continue;
    }
    // Binary parts (images, etc.) — decode to bytes and index by Content-Location.
    if (!location) continue;
    let bytes: Uint8Array;
    if (encoding === "base64") {
      const b64 = body.replace(/\s+/g, "");
      const bin = atob(b64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else if (encoding === "quoted-printable") {
      const decoded = decodeQuotedPrintable(body);
      bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i) & 0xff;
    } else {
      // 7bit/8bit/binary — best-effort raw bytes
      bytes = new Uint8Array(body.length);
      for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
    }
    embedded.set(location, { contentType: contentType || "application/octet-stream", bytes });
  }
  return { html, embedded };
}

function decodeQuotedPrintable(input: string): string {
  // Soft line breaks: '=' at end of line
  const joined = input.replace(/=\r?\n/g, "");
  // Decode =XX escapes as UTF-8 bytes
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i];
    if (c === "=" && i + 2 < joined.length) {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(c.charCodeAt(0));
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

function parseTotesFromHtml(html: string): ParsedTote[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const toteNodes = doc.querySelectorAll(".tote");
  const totes: ParsedTote[] = [];
  toteNodes.forEach((node) => {
    const header = node.querySelector(".toteh");
    const toteIdText = header?.querySelector("h2")?.textContent ?? "";
    const toteId = toteIdText.replace(/^ID:\s*/i, "").trim();
    const h3Html = header?.querySelector("h3")?.innerHTML ?? "";
    const meta = parseHeaderMeta(h3Html);
    const items: ParsedItem[] = [];
    node.querySelectorAll(":scope > .item").forEach((itemNode) => {
      items.push(parseItem(itemNode as HTMLElement));
    });
    totes.push({
      toteId,
      title: meta["Title"] ?? "",
      location: meta["Location"] ?? "",
      profile: meta["Profile"] ?? "",
      parentToteId: (meta["Parent ToteID"] ?? "").replace(/^none$/i, ""),
      dateUpdated: meta["Date Updated"] ?? "",
      items,
    });
  });
  return totes;
}

function parseHeaderMeta(innerHtml: string): Record<string, string> {
  // "Title: Steam Inhaler<br>Location: BLUE MEDICAL...<br>Profile: ..."
  const out: Record<string, string> = {};
  const lines = innerHtml.split(/<br\s*\/?>/i);
  for (const line of lines) {
    const text = stripHtml(line).trim();
    if (!text) continue;
    const idx = text.indexOf(":");
    if (idx === -1) continue;
    const key = text.slice(0, idx).trim();
    const value = text.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

function parseItem(node: HTMLElement): ParsedItem {
  const headerText = node.querySelector("h3")?.textContent ?? "";
  // "Item #:1 -- Purmist Steam Inhaler"
  const m = /Item\s*#:\s*(\d+)\s*--\s*(.*)$/i.exec(headerText.trim());
  const itemNumber = m ? parseInt(m[1], 10) : 0;
  const name = m ? m[2].trim() : headerText.trim();

  const innerHtml = node.innerHTML;
  const fields = parseFieldsFromInnerHtml(innerHtml);
  const imgs: string[] = [];
  node.querySelectorAll("a[href], img[src]").forEach((el) => {
    const url = el.getAttribute("href") ?? el.getAttribute("src") ?? "";
    if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(url) && !imgs.includes(url)) imgs.push(url);
  });
  // Prefer originals: if we saw both original + resized for same file, keep original
  const originals = imgs.filter((u) => /\/original\//i.test(u));
  const finalImgs = originals.length > 0 ? originals : imgs;

  return {
    itemNumber,
    name,
    quantity: parseInt(fields["Quantity"] ?? "1", 10) || 1,
    description: fields["Description"] ?? "",
    upc: (fields["UPC"] ?? "").replace(/^\(none\)$/i, ""),
    created: fields["Created"] ?? "",
    updated: fields["Updated"] ?? "",
    imageUrls: finalImgs,
  };
}

function parseFieldsFromInnerHtml(innerHtml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = innerHtml.split(/<br\s*\/?>/i);
  for (const line of lines) {
    const text = stripHtml(line).trim();
    if (!text) continue;
    const m = /^(Quantity|Description|UPC|Created|Updated|Images)\s*:\s*(.*)$/i.exec(text);
    if (m) out[capitalize(m[1])] = m[2].trim();
  }
  return out;
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? "" : String(v);
  });
}
