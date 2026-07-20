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

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
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
      const res = await fetch(url, { method, headers: { ...this.authHeaders(), ...headers }, body });
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
    this.token = data.token;
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

  private async listEntitiesByType(typeId: string): Promise<Array<{ id: string; name: string; description?: string }>> {
    const results: Array<{ id: string; name: string; description?: string }> = [];
    let page = 1;
    while (true) {
      const r = await this.request("GET", `/api/v1/entities?page=${page}&pageSize=500`);
      if (!r.ok) throw new Error(`List entities failed: ${r.status}`);
      const body = await r.json();
      const items: Array<{ id: string; name: string; description?: string; entityType?: { id?: string; isLocation?: boolean } }> =
        Array.isArray(body) ? body : (body.items ?? []);
      for (const it of items) {
        if (it.entityType?.id === typeId) results.push({ id: it.id, name: it.name, description: it.description });
      }
      const total = body?.total ?? items.length;
      if (page * 500 >= total || items.length === 0) break;
      page++;
    }
    return results;
  }

  async listLocations(): Promise<HomeboxLocation[]> {
    if (!this.locationTypeId) await this.ensureEntityTypes();
    return this.listEntitiesByType(this.locationTypeId!);
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

  // Fetch every existing item entity and index them by their import_ref custom field
  // so re-runs can skip previously-imported items.
  async indexItemsByImportRef(): Promise<Map<string, ExistingItemIndex>> {
    if (!this.itemTypeId) await this.ensureEntityTypes();
    const index = new Map<string, ExistingItemIndex>();
    let page = 1;
    while (true) {
      const r = await this.request("GET", `/api/v1/entities?page=${page}&pageSize=500`);
      if (!r.ok) throw new Error(`List entities failed: ${r.status}`);
      const body = await r.json();
      const items: Array<{
        id: string;
        name: string;
        entityType?: { id?: string };
        fields?: Array<{ name?: string; textValue?: string }>;
      }> = Array.isArray(body) ? body : (body.items ?? []);
      for (const it of items) {
        if (it.entityType?.id !== this.itemTypeId) continue;
        const ref = Array.isArray(it.fields)
          ? it.fields.find((f) => (f.name ?? "").toLowerCase() === "import_ref")?.textValue
          : undefined;
        if (ref) index.set(ref, { id: it.id, name: it.name, importRef: ref });
      }
      const total = body?.total ?? items.length;
      if (page * 500 >= total || items.length === 0) break;
      page++;
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
