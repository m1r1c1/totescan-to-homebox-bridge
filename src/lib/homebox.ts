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

export class HomeboxClient {
  baseUrl: string;
  token: string | null = null;
  locationTypeId: string | null = null;
  itemTypeId: string | null = null;

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    if (token) this.token = token;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  async login(username: string, password: string): Promise<HomeboxLoginResponse> {
    const r = await fetch(`${this.baseUrl}/api/v1/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, stayLoggedIn: true }),
    });
    if (!r.ok) throw new Error(`Homebox login failed: ${r.status} ${await safeText(r)}`);
    const data = (await r.json()) as HomeboxLoginResponse;
    this.token = data.token;
    return data;
  }

  // Discover / create the entity types used for locations and items.
  async ensureEntityTypes(): Promise<{ locationTypeId: string; itemTypeId: string }> {
    const r = await fetch(`${this.baseUrl}/api/v1/entity-types`, { headers: this.authHeaders() });
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
    const r = await fetch(`${this.baseUrl}/api/v1/entity-types`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name, isLocation, icon: "" }),
    });
    if (!r.ok) throw new Error(`Create entity type failed: ${r.status} ${await safeText(r)}`);
    return (await r.json()) as HomeboxEntityType;
  }

  private async listEntitiesByType(typeId: string): Promise<Array<{ id: string; name: string; description?: string }>> {
    const results: Array<{ id: string; name: string; description?: string }> = [];
    let page = 1;
    // Fetch all pages; server also supports filtering, but we filter client-side by entityType.id.
    // Uses a large pageSize to minimize round-trips.
    while (true) {
      const r = await fetch(
        `${this.baseUrl}/api/v1/entities?page=${page}&pageSize=500`,
        { headers: this.authHeaders() },
      );
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
    const r = await fetch(`${this.baseUrl}/api/v1/entities`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name, description, entityTypeId: this.locationTypeId }),
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
  }): Promise<HomeboxItem> {
    if (!this.itemTypeId) await this.ensureEntityTypes();
    const body: Record<string, unknown> = {
      name: payload.name,
      description: payload.description ?? "",
      parentId: payload.locationId,
      entityTypeId: this.itemTypeId,
      quantity: payload.quantity ?? 1,
    };
    if (payload.labelIds && payload.labelIds.length > 0) body.tagIds = payload.labelIds;
    const r = await fetch(`${this.baseUrl}/api/v1/entities`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Create item failed: ${r.status} ${await safeText(r)}`);
    const out = await r.json();
    // assetId lives on Update, apply as a follow-up if requested.
    if (payload.assetId) {
      try {
        await this.updateItem(out.id, { assetId: payload.assetId });
      } catch {
        /* non-fatal */
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
  }): Promise<void> {
    // PUT expects the full entity shape; fetch current then merge.
    const cur = await fetch(`${this.baseUrl}/api/v1/entities/${itemId}`, { headers: this.authHeaders() });
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
    };
    // Strip fields the update endpoint doesn't accept.
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

    const r = await fetch(`${this.baseUrl}/api/v1/entities/${itemId}`, {
      method: "PUT",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Update item failed: ${r.status} ${await safeText(r)}`);
  }

  async listLabels(): Promise<HomeboxLabel[]> {
    const r = await fetch(`${this.baseUrl}/api/v1/tags`, { headers: this.authHeaders() });
    if (!r.ok) throw new Error(`List tags failed: ${r.status}`);
    const body = await r.json();
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.items)) return body.items;
    return [];
  }

  async createLabel(name: string, description = ""): Promise<HomeboxLabel> {
    const r = await fetch(`${this.baseUrl}/api/v1/tags`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name, description }),
    });
    if (!r.ok) throw new Error(`Create tag failed: ${r.status} ${await safeText(r)}`);
    return (await r.json()) as HomeboxLabel;
  }

  async uploadAttachment(itemId: string, blob: Blob, filename: string, type = "photo"): Promise<void> {
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("type", type);
    form.append("name", filename);
    form.append("primary", "false");
    const r = await fetch(`${this.baseUrl}/api/v1/entities/${itemId}/attachments`, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
    });
    if (!r.ok) throw new Error(`Upload attachment failed: ${r.status} ${await safeText(r)}`);
  }
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
