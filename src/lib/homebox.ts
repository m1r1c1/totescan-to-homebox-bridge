// Minimal Homebox API client (browser-side).
// Docs: https://homebox.software/api/

export interface HomeboxLoginResponse {
  token: string;
  expiresAt: string;
  attachmentToken?: string;
}

export interface HomeboxLocation {
  id: string;
  name: string;
  description?: string;
}

export interface HomeboxLabel {
  id: string;
  name: string;
  description?: string;
}

export interface HomeboxItem {
  id: string;
  name: string;
}

export class HomeboxClient {
  baseUrl: string;
  token: string | null = null;

  constructor(baseUrl: string, token?: string) {
    // strip trailing slash
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

  async listLocations(): Promise<HomeboxLocation[]> {
    const r = await fetch(`${this.baseUrl}/api/v1/locations`, { headers: this.authHeaders() });
    if (!r.ok) throw new Error(`List locations failed: ${r.status}`);
    const body = await r.json();
    // Homebox returns either an array or {items: []}
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.items)) return body.items;
    return [];
  }

  async createLocation(name: string, description = ""): Promise<HomeboxLocation> {
    const r = await fetch(`${this.baseUrl}/api/v1/locations`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name, description }),
    });
    if (!r.ok) throw new Error(`Create location failed: ${r.status} ${await safeText(r)}`);
    return (await r.json()) as HomeboxLocation;
  }

  async createItem(payload: {
    name: string;
    description?: string;
    locationId: string;
    quantity?: number;
    assetId?: string;
    labelIds?: string[];
  }): Promise<HomeboxItem> {
    const body: Record<string, unknown> = {
      name: payload.name,
      description: payload.description ?? "",
      locationId: payload.locationId,
      quantity: payload.quantity ?? 1,
    };
    if (payload.assetId) body.assetId = payload.assetId;
    if (payload.labelIds && payload.labelIds.length > 0) body.labelIds = payload.labelIds;
    const r = await fetch(`${this.baseUrl}/api/v1/items`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Create item failed: ${r.status} ${await safeText(r)}`);
    return (await r.json()) as HomeboxItem;
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
    // Homebox PUT expects a full item shape; fetch current then merge.
    const cur = await fetch(`${this.baseUrl}/api/v1/items/${itemId}`, { headers: this.authHeaders() });
    if (!cur.ok) throw new Error(`Fetch item failed: ${cur.status}`);
    const current = await cur.json();
    const body: Record<string, unknown> = {
      ...current,
      ...patch,
      locationId: patch.locationId ?? current?.location?.id ?? current?.locationId,
      labelIds: patch.labelIds ?? (Array.isArray(current?.labels) ? current.labels.map((l: { id: string }) => l.id) : []),
    };
    const r = await fetch(`${this.baseUrl}/api/v1/items/${itemId}`, {
      method: "PUT",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Update item failed: ${r.status} ${await safeText(r)}`);
  }

  async listLabels(): Promise<HomeboxLabel[]> {
    const r = await fetch(`${this.baseUrl}/api/v1/labels`, { headers: this.authHeaders() });
    if (!r.ok) throw new Error(`List labels failed: ${r.status}`);
    const body = await r.json();
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.items)) return body.items;
    return [];
  }

  async createLabel(name: string, description = ""): Promise<HomeboxLabel> {
    const r = await fetch(`${this.baseUrl}/api/v1/labels`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name, description, color: "" }),
    });
    if (!r.ok) throw new Error(`Create label failed: ${r.status} ${await safeText(r)}`);
    return (await r.json()) as HomeboxLabel;
  }


  async uploadAttachment(itemId: string, blob: Blob, filename: string, type = "photo"): Promise<void> {
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("type", type);
    form.append("name", filename);
    const r = await fetch(`${this.baseUrl}/api/v1/items/${itemId}/attachments`, {
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
