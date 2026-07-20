// Homebox API client (browser-side) — targets the redesigned "entities" API.
// Locations, items, etc. are all entities differentiated by an entity type
// (a type with `isLocation: true` is a location). Labels are now called tags.

export interface HomeboxLoginResponse {
  token: string;
  expiresAt: string;
  attachmentToken?: string;
}

export interface HomeboxEntityType {
  id: string;
  name: string;
  isLocation: boolean;
  icon?: string;
}

export interface HomeboxLocation {
  id: string;
  name: string;
  description?: string;
}

// Kept the "Label" name so the UI keeps working; these are Homebox tags.
export interface HomeboxLabel {
  id: string;
  name: string;
  description?: string;
  color?: string;
}

export interface HomeboxItem {
  id: string;
  name: string;
}

export interface HomeboxCustomField {
  name: string;
  type?: string;
  textValue?: string;
  numberValue?: number;
  booleanValue?: boolean;
}

export interface ExistingItemIndex {
  id: string;
  name: string;
  importRef?: string;
}

export interface DiagnosticEntry {
  id: number;
  timestamp: string;
  phase: string;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  ok: boolean;
  durationMs: number;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  error?: string;
}

export type DiagnosticListener = (entry: DiagnosticEntry) => void;

const MAX_BODY_CHARS = 4000;
let diagCounter = 0;

function truncate(s: string): string {
  if (s.length <= MAX_BODY_CHARS) return s;
  return s.slice(0, MAX_BODY_CHARS) + `\n… (${s.length - MAX_BODY_CHARS} more chars truncated)`;
}

function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (/^authorization$/i.test(k)) out[k] = v ? `Bearer •••${v.slice(-6)}` : "";
    else out[k] = v;
  }
  return out;
}

export class HomeboxClient {
  baseUrl: string;
  token: string | null = null;
  locationTypeId: string | null = null;
  itemTypeId: string | null = null;
  onDiagnostic: DiagnosticListener | null = null;
  phase = "idle";

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    if (token) this.token = token;
  }

  setPhase(phase: string) {
    this.phase = phase;
  }

  // When suppressAuthHeader is true, skip the Authorization header entirely so
  // the request relies on the browser-managed cookie (hb.auth.token) alone.
  suppressAuthHeader = false;

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token && !this.suppressAuthHeader) {
      // Homebox may return the token already prefixed with "Bearer " — don't double it.
      const raw = this.token.trim();
      const value = /^bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`;
      h["Authorization"] = value;
    }
    return h;
  }

  // Reissues a lightweight authenticated call WITHOUT the Authorization header
  // to prove whether the browser is sending the hb.auth.token cookie. Returns
  // true on 2xx (cookie auth works), false otherwise.
  async testCookieOnlyAuth(): Promise<{ ok: boolean; status: number }> {
    const prev = this.suppressAuthHeader;
    this.suppressAuthHeader = true;
    const prevPhase = this.phase;
    this.setPhase("diagnostics:cookie-only");
    try {
      const r = await this.request("GET", `/api/v1/users/self`);
      return { ok: r.ok, status: r.status };
    } finally {
      this.suppressAuthHeader = prev;
      this.setPhase(prevPhase);
    }
  }

  // Central fetch wrapper — records every request/response for diagnostics.
  private async request(
    method: string,
    path: string,
    opts: { headers?: Record<string, string>; body?: BodyInit | null; jsonBody?: unknown } = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let body: BodyInit | null | undefined = opts.body;
    let bodyPreview: string | undefined;

    if (opts.jsonBody !== undefined) {
      headers["Content-Type"] = "application/json";
      const json = JSON.stringify(opts.jsonBody);
      body = json;
      bodyPreview = json;
    } else if (typeof body === "string") {
      bodyPreview = body;
    } else if (body instanceof FormData) {
      const parts: string[] = [];
      body.forEach((v, k) => {
        if (v instanceof Blob) parts.push(`${k}=<Blob ${v.size}B ${v.type || "?"}>`);
        else parts.push(`${k}=${String(v)}`);
      });
      bodyPreview = `FormData { ${parts.join(", ")} }`;
    }

    const id = ++diagCounter;
    const phase = this.phase;
    const started = performance.now();
    const timestamp = new Date().toISOString();
    const reqHeaders = redactHeaders({ ...this.authHeaders(), ...headers });

    try {
      const res = await fetch(url, {
        method,
        headers: { ...this.authHeaders(), ...headers },
        body,
        credentials: "include",
      });
      const durationMs = Math.round(performance.now() - started);
      let respText = "";
      try {
        // Clone so callers can still consume the body downstream.
        respText = truncate(await res.clone().text());
      } catch {
        respText = "<unreadable>";
      }
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => (respHeaders[k] = v));
      this.onDiagnostic?.({
        id,
        timestamp,
        phase,
        method,
        url,
        status: res.status,
        statusText: res.statusText,
        ok: res.ok,
        durationMs,
        requestHeaders: reqHeaders,
        requestBody: bodyPreview ? truncate(bodyPreview) : undefined,
        responseHeaders: respHeaders,
        responseBody: respText,
      });
      return res;
    } catch (e) {
      const durationMs = Math.round(performance.now() - started);
      this.onDiagnostic?.({
        id,
        timestamp,
        phase,
        method,
        url,
        ok: false,
        durationMs,
        requestHeaders: reqHeaders,
        requestBody: bodyPreview ? truncate(bodyPreview) : undefined,
        error: (e as Error).message,
      });
      throw e;
    }
  }

  async login(username: string, password: string): Promise<HomeboxLoginResponse> {
    const r = await this.request("POST", `/api/v1/users/login`, {
      jsonBody: { username, password, stayLoggedIn: true },
    });
    if (!r.ok) throw new Error(`Homebox login failed: ${r.status} ${await safeText(r)}`);
    const data = (await r.json()) as HomeboxLoginResponse;
    this.token = (data.token ?? "").replace(/^bearer\s+/i, "").trim();
    return data;
  }

  async ensureEntityTypes(): Promise<{ locationTypeId: string; itemTypeId: string }> {
    const r = await this.request("GET", `/api/v1/entity-types`);
    if (!r.ok) throw new Error(`List entity types failed: ${r.status} ${await safeText(r)}`);
    const types = (await r.json()) as HomeboxEntityType[];
    let loc = types.find((t) => t.isLocation);
    let item = types.find((t) => !t.isLocation);
    if (!loc) loc = await this.createEntityType("Location", true);
    if (!item) item = await this.createEntityType("Item", false);
    this.locationTypeId = loc.id;
    this.itemTypeId = item.id;
    return { locationTypeId: loc.id, itemTypeId: item.id };
  }

  async createEntityType(name: string, isLocation: boolean): Promise<HomeboxEntityType> {
    const r = await this.request("POST", `/api/v1/entity-types`, {
      jsonBody: { name, isLocation, icon: "" },
    });
    if (!r.ok) throw new Error(`Create entity type failed: ${r.status} ${await safeText(r)}`);
    return (await r.json()) as HomeboxEntityType;
  }

  // Filters by a predicate against the entity's type. Homebox allows many
  // entity types with isLocation=true (Room, Shelf, Box, …) or with
  // isLocation=false (Item, Tool, …), so filtering by a single typeId misses
  // most entities. Predicate lets callers match by isLocation flag instead.
  private async listEntitiesWhere(
    match: (t: { id?: string; isLocation?: boolean } | undefined) => boolean,
  ): Promise<Array<{ id: string; name: string; description?: string }>> {
    const results: Array<{ id: string; name: string; description?: string }> = [];
    let page = 1;
    while (true) {
      const r = await this.request("GET", `/api/v1/entities?page=${page}&pageSize=500`);
      if (!r.ok) throw new Error(`List entities failed: ${r.status}`);
      const body = await r.json();
      const items: Array<{ id: string; name: string; description?: string; entityType?: { id?: string; isLocation?: boolean } }> =
        Array.isArray(body) ? body : (body.items ?? []);
      for (const it of items) {
        if (match(it.entityType)) results.push({ id: it.id, name: it.name, description: it.description });
      }
      const total = body?.total ?? items.length;
      if (page * 500 >= total || items.length === 0) break;
      page++;
    }
    return results;
  }

  // Homebox's /v1/entities endpoint returns items only (locations are excluded
  // even though they're technically entities). The dedicated
  // /v1/entities/tree endpoint — "Get Locations Tree" per swagger — returns
  // the full location hierarchy. We flatten it so the UI still gets a flat
  // list of {id, name} for the dropdown.
  async listLocations(): Promise<HomeboxLocation[]> {
    const r = await this.request("GET", `/api/v1/entities/tree?withItems=false`);
    if (!r.ok) throw new Error(`List locations failed: ${r.status} ${await safeText(r)}`);
    const tree = (await r.json()) as Array<{
      id: string;
      name: string;
      type?: string;
      children?: unknown[];
    }>;
    const out: HomeboxLocation[] = [];
    const walk = (nodes: typeof tree, prefix = "") => {
      for (const n of nodes ?? []) {
        const displayName = prefix ? `${prefix} / ${n.name}` : n.name;
        out.push({ id: n.id, name: displayName });
        if (Array.isArray(n.children) && n.children.length > 0) {
          walk(n.children as typeof tree, displayName);
        }
      }
    };
    walk(Array.isArray(tree) ? tree : []);
    return out;
  }

  async createLocation(name: string, description = ""): Promise<HomeboxLocation> {
    if (!this.locationTypeId) await this.ensureEntityTypes();
    const r = await this.request("POST", `/api/v1/entities`, {
      jsonBody: { name, description, entityTypeId: this.locationTypeId },
    });
    if (!r.ok) throw new Error(`Create location failed: ${r.status} ${await safeText(r)}`);
    const out = await r.json();
    return { id: out.id, name: out.name, description: out.description };
  }

  async createItem(payload: {
    name: string;
    description?: string;
    locationId: string;
    quantity?: number;
    assetId?: string;
    labelIds?: string[];
    fields?: HomeboxCustomField[];
  }): Promise<HomeboxItem> {
    if (!this.itemTypeId) await this.ensureEntityTypes();
    // EntityCreate schema does not accept `fields` or `assetId` — those
    // must be applied via a follow-up PUT to /entities/{id}.
    const body: Record<string, unknown> = {
      name: payload.name,
      description: payload.description ?? "",
      parentId: payload.locationId,
      entityTypeId: this.itemTypeId,
      quantity: payload.quantity ?? 1,
    };
    if (payload.labelIds && payload.labelIds.length > 0) body.tagIds = payload.labelIds;
    const r = await this.request("POST", `/api/v1/entities`, { jsonBody: body });
    if (!r.ok) throw new Error(`Create item failed: ${r.status} ${await safeText(r)}`);
    const out = await r.json();
    const needsPatch = (payload.fields && payload.fields.length > 0) || !!payload.assetId;
    if (needsPatch) {
      try {
        await this.updateItem(out.id, {
          assetId: payload.assetId,
          fields: payload.fields,
        });
      } catch {
        /* non-fatal — creation succeeded */
      }
    }
    return { id: out.id, name: out.name };
  }

  async updateItem(itemId: string, patch: {
    name?: string;
    description?: string;
    notes?: string;
    quantity?: number;
    locationId?: string;
    assetId?: string;
    labelIds?: string[];
    fields?: HomeboxCustomField[];
  }): Promise<void> {
    const cur = await this.request("GET", `/api/v1/entities/${itemId}`);
    if (!cur.ok) throw new Error(`Fetch entity failed: ${cur.status}`);
    const current = await cur.json();
    const body: Record<string, unknown> = {
      ...current,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description ?? "",
      notes: patch.notes ?? current.notes ?? "",
      quantity: patch.quantity ?? current.quantity ?? 1,
      assetId: patch.assetId ?? current.assetId ?? "",
      entityTypeId: current.entityType?.id ?? this.itemTypeId,
      parentId: patch.locationId ?? current.parent?.id ?? current.parentId ?? "",
      tagIds:
        patch.labelIds ??
        (Array.isArray(current?.tags) ? current.tags.map((t: { id: string }) => t.id) : []),
      fields: patch.fields
        ? normalizeFields(patch.fields)
        : Array.isArray(current?.fields)
          ? current.fields
          : [],
    };
    delete body.entityType;
    delete body.parent;
    delete body.tags;
    delete body.children;
    delete body.attachments;
    delete body.createdAt;
    delete body.updatedAt;
    delete body.itemCount;
    delete body.totalPrice;
    delete body.imageId;
    delete body.thumbnailId;

    const r = await this.request("PUT", `/api/v1/entities/${itemId}`, { jsonBody: body });
    if (!r.ok) throw new Error(`Update item failed: ${r.status} ${await safeText(r)}`);
  }

  // Index existing items by their `import_ref` custom field so re-runs can
  // skip previously-imported items. EntitySummary from the list endpoint does
  // NOT include the `fields` array (per Homebox swagger), so we must fetch
  // each item's full entity to read custom fields. Done in small parallel
  // batches to avoid hammering the server.
  async indexItemsByImportRef(
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<string, ExistingItemIndex>> {
    if (!this.itemTypeId) await this.ensureEntityTypes();
    const index = new Map<string, ExistingItemIndex>();

    // 1) Collect all item-type entity summaries (id + name only).
    const summaries: Array<{ id: string; name: string }> = [];
    let page = 1;
    while (true) {
      const r = await this.request("GET", `/api/v1/entities?page=${page}&pageSize=500`);
      if (!r.ok) throw new Error(`List entities failed: ${r.status}`);
      const body = await r.json();
      const items: Array<{ id: string; name: string; entityType?: { id?: string; isLocation?: boolean } }> =
        Array.isArray(body) ? body : (body.items ?? []);
      for (const it of items) {
        // Any non-location entity type counts as an "item" for import purposes.
        if (it.entityType && !it.entityType.isLocation) summaries.push({ id: it.id, name: it.name });
      }
      const total = body?.total ?? items.length;
      if (page * 500 >= total || items.length === 0) break;
      page++;
    }

    // 2) Fetch full details in batches of 8 and pluck `import_ref`.
    const BATCH = 8;
    let done = 0;
    for (let i = 0; i < summaries.length; i += BATCH) {
      const chunk = summaries.slice(i, i + BATCH);
      const results = await Promise.all(
        chunk.map(async (s) => {
          try {
            const r = await this.request("GET", `/api/v1/entities/${s.id}`);
            if (!r.ok) return null;
            const full = (await r.json()) as {
              id: string;
              name: string;
              fields?: Array<{ name?: string; textValue?: string }>;
            };
            const ref = Array.isArray(full.fields)
              ? full.fields.find((f) => (f.name ?? "").toLowerCase() === "import_ref")?.textValue
              : undefined;
            return ref ? { id: full.id, name: full.name, importRef: ref } : null;
          } catch {
            return null;
          }
        }),
      );
      for (const r of results) if (r) index.set(r.importRef!, r);
      done += chunk.length;
      onProgress?.(done, summaries.length);
    }

    return index;
  }

  async listLabels(): Promise<HomeboxLabel[]> {
    const r = await this.request("GET", `/api/v1/tags`);
    if (!r.ok) throw new Error(`List tags failed: ${r.status}`);
    const body = await r.json();
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.items)) return body.items;
    return [];
  }

  async createLabel(name: string, description = ""): Promise<HomeboxLabel> {
    const r = await this.request("POST", `/api/v1/tags`, { jsonBody: { name, description } });
    if (!r.ok) throw new Error(`Create tag failed: ${r.status} ${await safeText(r)}`);
    return (await r.json()) as HomeboxLabel;
  }

  async uploadAttachment(
    itemId: string,
    blob: Blob,
    filename: string,
    type = "photo",
    primary = false,
  ): Promise<void> {
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("type", type);
    form.append("name", filename);
    form.append("primary", primary ? "true" : "false");
    const r = await this.request("POST", `/api/v1/entities/${itemId}/attachments`, { body: form });
    if (!r.ok) throw new Error(`Upload attachment failed: ${r.status} ${await safeText(r)}`);
  }
}

function normalizeFields(fields: HomeboxCustomField[]): HomeboxCustomField[] {
  return fields.map((f) => ({
    name: f.name,
    type: f.type ?? "text",
    textValue: f.textValue ?? "",
  }));
}


async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 200);
  } catch {
    return "";
  }
}

export async function fetchImageAsBlob(url: string): Promise<Blob> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Image fetch failed ${r.status}`);
  return await r.blob();
}
