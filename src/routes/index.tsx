import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Upload, Package, CheckCircle2, XCircle, Loader2, Boxes, FileText, Settings2, Send, Image as ImageIcon, ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { parseTotescanFile, renderTemplate, resolveImageBlob, type ParsedTote, type EmbeddedPartsMap } from "@/lib/mhtml";
import { HomeboxClient, type HomeboxLocation, type HomeboxLabel, type DiagnosticEntry, type HomeboxCustomField, type ExistingItemIndex } from "@/lib/homebox";
import { DEFAULT_MAPPING, TOTE_VARIABLES, ITEM_VARIABLES, buildImportRef, type MappingConfig, type CustomFieldMapping } from "@/lib/mapping";
import { Trash2, Plus } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Totescan → Homebox Migrator" },
      {
        name: "description",
        content:
          "Convert Totescan MHTML exports into Homebox locations, items, and photos via the Homebox API. Self-hostable, browser-based.",
      },
      { property: "og:title", content: "Totescan → Homebox Migrator" },
      {
        property: "og:description",
        content:
          "Convert Totescan MHTML exports into Homebox locations, items, and photos via the Homebox API.",
      },
    ],
  }),
  component: App,
});

interface LogEntry {
  level: "info" | "ok" | "error";
  text: string;
}

function App() {
  const [totes, setTotes] = useState<ParsedTote[]>([]);
  const [embedded, setEmbedded] = useState<EmbeddedPartsMap>(new Map());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [mapping, setMapping] = useState<MappingConfig>(DEFAULT_MAPPING);
  const [conn, setConn] = useState({ baseUrl: "", username: "", password: "", token: "" });
  const [client, setClient] = useState<HomeboxClient | null>(null);
  const [existingLocations, setExistingLocations] = useState<HomeboxLocation[]>([]);
  const [existingLabels, setExistingLabels] = useState<HomeboxLabel[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  const selectedTotes = useMemo(
    () => totes.filter((t) => selectedIds.has(t.toteId)),
    [totes, selectedIds],
  );
  const totalItems = useMemo(
    () => selectedTotes.reduce((n, t) => n + t.items.length, 0),
    [selectedTotes],
  );

  async function handleFile(file: File) {
    try {
      const parsed = await parseTotescanFile(file);
      if (parsed.totes.length === 0) {
        toast.error("No totes found in that file. Is it a Totescan MHTML export?");
        return;
      }
      setTotes(parsed.totes);
      setEmbedded(parsed.embedded);
      setSelectedIds(new Set(parsed.totes.map((t) => t.toteId)));
      const itemCount = parsed.totes.reduce((n, t) => n + t.items.length, 0);
      toast.success(`Parsed ${parsed.totes.length} totes, ${itemCount} items, ${parsed.embedded.size} embedded images.`);
    } catch (e) {
      toast.error(`Failed to parse: ${(e as Error).message}`);
    }
  }

  async function handleConnect() {
    if (!conn.baseUrl) return toast.error("Homebox URL is required.");
    const c = new HomeboxClient(conn.baseUrl);
    c.onDiagnostic = (entry) => setDiagnostics((prev) => [...prev, entry]);
    setDiagnostics([]);
    try {
      c.setPhase("connect:login");
      if (conn.token) {
        c.token = conn.token;
      } else {
        await c.login(conn.username, conn.password);
      }
      c.setPhase("connect:entity-types");
      await c.ensureEntityTypes();
      c.setPhase("connect:list-locations");
      const locs = await c.listLocations();
      c.setPhase("connect:list-tags");
      const labels = await c.listLabels().catch(() => [] as HomeboxLabel[]);
      c.setPhase("idle");
      setClient(c);
      setExistingLocations(locs);
      setExistingLabels(labels);
      toast.success(`Connected. Found ${locs.length} locations, ${labels.length} tags.`);
    } catch (e) {
      toast.error(`Connection failed: ${(e as Error).message}. Check the URL, credentials, and CORS on your Homebox instance.`);
    }
  }

  function log(entry: LogEntry) {
    setLogs((prev) => [...prev, entry]);
  }

  async function runImport() {
    if (!client) return;
    setRunning(true);
    setDone(false);
    setLogs([]);
    setDiagnostics([]);
    setProgress(0);

    const totalSteps = selectedTotes.length + totalItems;
    let stepDone = 0;
    const bumpProgress = () => {
      stepDone += 1;
      setProgress(Math.round((stepDone / totalSteps) * 100));
    };

    const existingByName = new Map(existingLocations.map((l) => [l.name.toLowerCase(), l]));
    const labelsByName = new Map(existingLabels.map((l) => [l.name.toLowerCase(), l]));

    // Pre-flight: build import_ref → existing item index for idempotent re-runs.
    let existingByRef = new Map<string, ExistingItemIndex>();
    if (mapping.skipExistingByImportRef) {
      try {
        client.setPhase("import:indexExisting");
        existingByRef = await client.indexItemsByImportRef();
        log({ level: "info", text: `Indexed ${existingByRef.size} existing items by import_ref.` });
      } catch (e) {
        log({ level: "error", text: `Failed to index existing items: ${(e as Error).message}` });
      }
    }

    async function resolveLabelIds(names: string[]): Promise<string[]> {
      const ids: string[] = [];
      for (const raw of names) {
        const name = raw.trim();
        if (!name) continue;
        const key = name.toLowerCase();
        let label = labelsByName.get(key);
        if (!label && mapping.createMissingTags) {
          try {
            client!.setPhase(`import:createTag "${name}"`);
            label = await client!.createLabel(name);
            labelsByName.set(key, label);
            log({ level: "ok", text: `  ~ Created tag "${name}"` });
          } catch (e) {
            log({ level: "error", text: `  ~ Tag "${name}" failed: ${(e as Error).message}` });
            continue;
          }
        }
        if (label) ids.push(label.id);
      }
      return ids;
    }

    for (const tote of selectedTotes) {
      const toteVars = {
        toteId: tote.toteId,
        title: tote.title,
        location: tote.location,
        profile: tote.profile,
        parentToteId: tote.parentToteId,
        dateUpdated: tote.dateUpdated,
      };
      const locName = renderTemplate(mapping.locationName, toteVars).trim() || tote.title || tote.toteId;
      const locDesc = renderTemplate(mapping.locationDescription, toteVars);

      let locationId: string;
      try {
        const existing = mapping.useExistingLocations ? existingByName.get(locName.toLowerCase()) : undefined;
        if (existing) {
          locationId = existing.id;
          log({ level: "info", text: `Using existing location "${locName}"` });
        } else {
          client.setPhase(`import:createLocation "${locName}"`);
          const created = await client.createLocation(locName, locDesc);
          locationId = created.id;
          existingByName.set(locName.toLowerCase(), created);
          log({ level: "ok", text: `Created location "${locName}"` });
        }
      } catch (e) {
        log({ level: "error", text: `Location "${locName}" failed: ${(e as Error).message}` });
        bumpProgress();
        continue;
      }
      bumpProgress();

      for (const item of tote.items) {
        const importRef = buildImportRef(tote.toteId, item.itemNumber);
        const itemVars = {
          ...toteVars,
          name: item.name,
          itemNumber: item.itemNumber,
          quantity: item.quantity,
          description: item.description,
          upc: item.upc,
          created: item.created,
          updated: item.updated,
        };
        const itemName = renderTemplate(mapping.itemName, itemVars).trim() || item.name;

        if (mapping.skipExistingByImportRef && existingByRef.has(importRef)) {
          log({ level: "info", text: `  = Skipped "${itemName}" (import_ref ${importRef} already imported)` });
          bumpProgress();
          continue;
        }

        const itemDesc = renderTemplate(mapping.itemDescription, itemVars);
        const itemNotes = mapping.itemNotes ? renderTemplate(mapping.itemNotes, itemVars) : "";
        const qtyStr = mapping.itemQuantity ? renderTemplate(mapping.itemQuantity, itemVars).trim() : "";
        const qtyNum = qtyStr ? parseInt(qtyStr, 10) : item.quantity;
        const quantity = Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : item.quantity;
        const assetId = mapping.itemAssetId ? renderTemplate(mapping.itemAssetId, itemVars).trim() : undefined;
        const tagNames = mapping.itemTags
          ? renderTemplate(mapping.itemTags, itemVars).split(",").map((s) => s.trim()).filter(Boolean)
          : [];

        // Build custom fields: user-defined + always-on import_ref.
        const customFields: HomeboxCustomField[] = [];
        for (const cf of mapping.customFields) {
          const name = cf.name.trim();
          if (!name) continue;
          const value = renderTemplate(cf.template, itemVars).trim();
          if (!value) continue;
          customFields.push({ name, type: "text", textValue: value });
        }
        customFields.push({ name: "import_ref", type: "text", textValue: importRef });

        try {
          const labelIds = tagNames.length > 0 ? await resolveLabelIds(tagNames) : [];
          client.setPhase(`import:createItem "${itemName}"`);
          const created = await client.createItem({
            name: itemName,
            description: itemDesc,
            locationId,
            quantity,
            assetId: assetId || undefined,
            labelIds: labelIds.length > 0 ? labelIds : undefined,
            fields: customFields,
          });
          existingByRef.set(importRef, { id: created.id, name: created.name, importRef });
          if (itemNotes) {
            try {
              client.setPhase(`import:updateItem "${itemName}"`);
              await client.updateItem(created.id, {
                notes: itemNotes,
              });
            } catch (e) {
              log({ level: "error", text: `  ! Item "${itemName}" notes update failed: ${(e as Error).message}` });
            }
          }
          log({ level: "ok", text: `  + Item "${itemName}"${labelIds.length ? ` [${tagNames.join(", ")}]` : ""}` });
          if (mapping.uploadImages && item.imageUrls.length > 0) {
            let primaryAssigned = false;
            for (const url of item.imageUrls) {
              try {
                const { blob, source } = await resolveImageBlob(url, embedded);
                const filename = url.split("/").pop()?.split("?")[0] ?? "photo.jpg";
                const isPrimary = !primaryAssigned;
                client.setPhase(`import:uploadAttachment "${filename}" (${source})`);
                await client.uploadAttachment(created.id, blob, filename, "photo", isPrimary);
                primaryAssigned = true;
                log({ level: "ok", text: `      photo ${filename} [${source}]${isPrimary ? " (primary)" : ""}` });
              } catch (e) {
                log({ level: "error", text: `      photo failed (${url}): ${(e as Error).message}` });
              }
            }
          }
        } catch (e) {
          log({ level: "error", text: `  ! Item "${itemName}" failed: ${(e as Error).message}` });
        }
        bumpProgress();
      }

    }

    setProgress(100);
    setRunning(false);
    setDone(true);
    toast.success("Import complete.");
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster theme="dark" richColors closeButton />
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Boxes className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Totescan → Homebox</h1>
              <p className="text-xs text-muted-foreground">Migrate MHTML exports into your self-hosted inventory</p>
            </div>
          </div>
          <div className="hidden items-center gap-4 text-xs text-muted-foreground md:flex">
            <span>{totes.length} totes parsed</span>
            <span>·</span>
            <span>{selectedTotes.length} selected · {totalItems} items</span>
            <span>·</span>
            <span className={client ? "text-primary" : ""}>{client ? "Connected" : "Not connected"}</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-6 py-8">
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          <DashboardSection id="upload" title="1. Upload export" icon={<FileText className="h-4 w-4" />} defaultOpen>
            <StepUpload onFile={handleFile} />
          </DashboardSection>

          <DashboardSection
            id="review"
            title="2. Review totes"
            icon={<Package className="h-4 w-4" />}
            badge={totes.length > 0 ? `${selectedIds.size}/${totes.length}` : undefined}
            defaultOpen
          >
            {totes.length === 0 ? (
              <EmptyHint text="Upload a Totescan export to see totes here." />
            ) : (
              <StepReview totes={totes} selectedIds={selectedIds} setSelectedIds={setSelectedIds} />
            )}
          </DashboardSection>

          <DashboardSection
            id="mapping"
            title="3. Field mapping"
            icon={<Settings2 className="h-4 w-4" />}
            defaultOpen
            className="xl:col-span-2"
          >
            <StepMapping mapping={mapping} setMapping={setMapping} sampleTote={selectedTotes[0] ?? totes[0]} />
          </DashboardSection>

          <DashboardSection
            id="connection"
            title="4. Homebox connection"
            icon={<Send className="h-4 w-4" />}
            badge={client ? "connected" : undefined}
            defaultOpen
          >
            <ConnectionCard
              conn={conn}
              setConn={setConn}
              client={client}
              handleConnect={handleConnect}
              existingLocations={existingLocations}
              running={running}
            />
          </DashboardSection>

          <DashboardSection
            id="import"
            title="5. Run import"
            icon={<Boxes className="h-4 w-4" />}
            badge={running ? `${progress}%` : done ? "done" : undefined}
            defaultOpen
          >
            <ImportRunner
              client={client}
              totalTotes={selectedTotes.length}
              totalItems={totalItems}
              logs={logs}
              progress={progress}
              running={running}
              done={done}
              onRun={runImport}
            />
          </DashboardSection>

          <DashboardSection
            id="diagnostics"
            title="Diagnostics"
            icon={<Settings2 className="h-4 w-4" />}
            badge={diagnostics.length > 0 ? String(diagnostics.length) : undefined}
            defaultOpen={false}
            className="xl:col-span-3"
          >
            <DiagnosticsPanel entries={diagnostics} onClear={() => setDiagnostics([])} client={client} />
          </DashboardSection>
        </div>
      </main>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <p className="rounded border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
      {text}
    </p>
  );
}

function DashboardSection({
  id,
  title,
  icon,
  badge,
  defaultOpen = true,
  className,
  children,
}: {
  id: string;
  title: string;
  icon?: ReactNode;
  badge?: string;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const storageKey = `dash.section.${id}.open`;
  const [open, setOpen] = useState(defaultOpen);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw !== null) setOpen(raw === "1");
    } catch {
      // ignore
    }
    setHydrated(true);
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(storageKey, open ? "1" : "0");
    } catch {
      // ignore
    }
  }, [open, hydrated, storageKey]);

  return (
    <section className={`rounded-lg border border-border bg-card ${className ?? ""}`}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-t-lg px-5 py-3 text-left hover:bg-muted/30">
          {icon && <span className="text-primary">{icon}</span>}
          <h2 className="flex-1 text-sm font-semibold tracking-tight">{title}</h2>
          {badge && (
            <Badge variant="secondary" className="font-mono text-[10px]">
              {badge}
            </Badge>
          )}
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border/60 px-5 py-4">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}


function StepUpload({ onFile }: { onFile: (f: File) => void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <FileText className="h-7 w-7" />
        </div>
        <h2 className="text-3xl font-semibold tracking-tight">Upload your Totescan export</h2>
        <p className="mt-2 text-muted-foreground">
          Drop the <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">.mhtml</span> or{" "}
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">.html</span> file you exported from Totescan.
          Everything is parsed in your browser — nothing is sent anywhere until you run the import.
        </p>
      </div>

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-12 transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-border bg-card/50 hover:border-primary/60"
        }`}
      >
        <Upload className="h-10 w-10 text-muted-foreground" />
        <p className="mt-4 font-medium">Click to choose or drag & drop</p>
        <p className="mt-1 text-sm text-muted-foreground">.mhtml, .mht, or .html</p>
        <input
          type="file"
          accept=".mhtml,.mht,.html,.htm,message/rfc822"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
          }}
        />
      </label>
    </div>
  );
}

function StepReview({
  totes,
  selectedIds,
  setSelectedIds,
}: {
  totes: ParsedTote[];
  selectedIds: Set<string>;
  setSelectedIds: (s: Set<string>) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };
  const allOn = selectedIds.size === totes.length;

  return (
    <div>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Review parsed totes</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {totes.length} totes · {totes.reduce((n, t) => n + t.items.length, 0)} items · {selectedIds.size} selected
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSelectedIds(allOn ? new Set() : new Set(totes.map((t) => t.toteId)))}
        >
          {allOn ? "Deselect all" : "Select all"}
        </Button>
      </div>

      <div className="space-y-3">
        {totes.map((t) => {
          const on = selectedIds.has(t.toteId);
          const isOpen = expanded === t.toteId;
          return (
            <div key={t.toteId} className="rounded-lg border border-border bg-card">
              <div className="flex items-center gap-3 p-4">
                <Switch checked={on} onCheckedChange={() => toggle(t.toteId)} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-primary">{t.toteId}</span>
                    <h3 className="truncate font-medium">{t.title || "(untitled)"}</h3>
                    <Badge variant="secondary" className="ml-auto">
                      {t.items.length} items
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {t.location} · {t.profile}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setExpanded(isOpen ? null : t.toteId)}>
                  {isOpen ? "Hide" : "Preview"}
                </Button>
              </div>
              {isOpen && (
                <div className="border-t border-border bg-background/50 p-4">
                  <ul className="space-y-2">
                    {t.items.map((item) => (
                      <li key={item.itemNumber} className="rounded-md border border-border/60 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium">{item.name}</p>
                            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{item.description}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                            <span>Qty {item.quantity}</span>
                            {item.imageUrls.length > 0 && (
                              <span className="flex items-center gap-1">
                                <ImageIcon className="h-3 w-3" />
                                {item.imageUrls.length}
                              </span>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StepMapping({
  mapping,
  setMapping,
  sampleTote,
}: {
  mapping: MappingConfig;
  setMapping: (m: MappingConfig) => void;
  sampleTote: ParsedTote | undefined;
}) {
  const sampleItem = sampleTote?.items[0];
  const toteVars: Record<string, string | number> = sampleTote
    ? {
        toteId: sampleTote.toteId,
        title: sampleTote.title,
        location: sampleTote.location,
        profile: sampleTote.profile,
        parentToteId: sampleTote.parentToteId,
        dateUpdated: sampleTote.dateUpdated,
      }
    : {};
  const itemVars: Record<string, string | number> = sampleItem
    ? { ...toteVars, name: sampleItem.name, itemNumber: sampleItem.itemNumber, quantity: sampleItem.quantity, description: sampleItem.description, upc: sampleItem.upc, created: sampleItem.created, updated: sampleItem.updated }
    : toteVars;

  const update = <K extends keyof MappingConfig>(k: K, v: MappingConfig[K]) => setMapping({ ...mapping, [k]: v });

  return (
    <div>
      <p className="mb-4 text-xs text-muted-foreground">
        Templates use <code className="rounded bg-muted px-1 text-xs">{"{variable}"}</code> placeholders. Preview updates live.
      </p>


      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-5">
          <h3 className="mb-4 flex items-center gap-2 font-semibold">
            <Package className="h-4 w-4 text-primary" /> Location (from each Tote)
          </h3>
          <VarChips vars={TOTE_VARIABLES} />
          <MappingField label="Location name" value={mapping.locationName} onChange={(v) => update("locationName", v)} preview={renderTemplate(mapping.locationName, toteVars)} />
          <MappingField label="Location description" value={mapping.locationDescription} onChange={(v) => update("locationDescription", v)} preview={renderTemplate(mapping.locationDescription, toteVars)} multiline />
          <div className="mt-4 flex items-center justify-between rounded-md border border-border/60 p-3">
            <div>
              <p className="text-sm font-medium">Reuse existing locations</p>
              <p className="text-xs text-muted-foreground">Match Homebox locations by name instead of creating duplicates.</p>
            </div>
            <Switch checked={mapping.useExistingLocations} onCheckedChange={(v) => update("useExistingLocations", v)} />
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-5">
          <h3 className="mb-4 flex items-center gap-2 font-semibold">
            <FileText className="h-4 w-4 text-primary" /> Items
          </h3>
          <VarChips vars={ITEM_VARIABLES} />
          <MappingField label="Item name" value={mapping.itemName} onChange={(v) => update("itemName", v)} preview={renderTemplate(mapping.itemName, itemVars)} />
          <MappingField label="Item description" value={mapping.itemDescription} onChange={(v) => update("itemDescription", v)} preview={renderTemplate(mapping.itemDescription, itemVars)} multiline />
          <MappingField label="Item notes" value={mapping.itemNotes} onChange={(v) => update("itemNotes", v)} preview={renderTemplate(mapping.itemNotes, itemVars)} placeholder="e.g. UPC: {upc}" multiline />
          <MappingField label="Quantity" value={mapping.itemQuantity} onChange={(v) => update("itemQuantity", v)} preview={renderTemplate(mapping.itemQuantity, itemVars)} placeholder="{quantity}" />
          <MappingField label="Tags (comma-separated)" value={mapping.itemTags} onChange={(v) => update("itemTags", v)} preview={renderTemplate(mapping.itemTags, itemVars)} placeholder="e.g. {profile}, {title}" />
          <MappingField label="Asset ID (optional)" value={mapping.itemAssetId} onChange={(v) => update("itemAssetId", v)} preview={renderTemplate(mapping.itemAssetId, itemVars)} placeholder="e.g. {toteId}-{itemNumber}" />
          <div className="mt-4 flex items-center justify-between rounded-md border border-border/60 p-3">
            <div>
              <p className="text-sm font-medium">Create missing tags</p>
              <p className="text-xs text-muted-foreground">Auto-create Homebox labels that don't yet exist.</p>
            </div>
            <Switch checked={mapping.createMissingTags} onCheckedChange={(v) => update("createMissingTags", v)} />
          </div>
          <div className="mt-3 flex items-center justify-between rounded-md border border-border/60 p-3">
            <div>
              <p className="text-sm font-medium">Upload item photos</p>
              <p className="text-xs text-muted-foreground">Fetches images from Totescan's S3 and attaches to each item. First photo becomes the primary.</p>
            </div>
            <Switch checked={mapping.uploadImages} onCheckedChange={(v) => update("uploadImages", v)} />
          </div>
          <div className="mt-3 flex items-center justify-between rounded-md border border-border/60 p-3">
            <div>
              <p className="text-sm font-medium">Skip items already imported</p>
              <p className="text-xs text-muted-foreground">Uses the <code className="font-mono text-[11px]">import_ref</code> custom field (<code className="font-mono text-[11px]">totescan-&#123;toteId&#125;-&#123;itemNumber&#125;</code>) as a checkpoint for safe re-runs.</p>
            </div>
            <Switch checked={mapping.skipExistingByImportRef} onCheckedChange={(v) => update("skipExistingByImportRef", v)} />
          </div>

          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <h4 className="text-sm font-semibold">Custom fields</h4>
                <p className="text-xs text-muted-foreground">Map any Totescan field into a Homebox custom field. Empty values are skipped.</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => update("customFields", [...mapping.customFields, { name: "", template: "" }])}
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add field
              </Button>
            </div>
            {mapping.customFields.length === 0 && (
              <p className="rounded border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
                No custom fields configured.
              </p>
            )}
            <div className="space-y-2">
              {mapping.customFields.map((cf, idx) => (
                <CustomFieldRow
                  key={idx}
                  field={cf}
                  preview={renderTemplate(cf.template, itemVars)}
                  onChange={(next) => {
                    const arr = [...mapping.customFields];
                    arr[idx] = next;
                    update("customFields", arr);
                  }}
                  onRemove={() => {
                    const arr = mapping.customFields.filter((_, i) => i !== idx);
                    update("customFields", arr);
                  }}
                />
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              An <code className="font-mono">import_ref</code> field is always written automatically for re-run safety.
            </p>
          </div>

        </section>
      </div>
    </div>
  );
}

function CustomFieldRow({
  field,
  preview,
  onChange,
  onRemove,
}: {
  field: CustomFieldMapping;
  preview: string;
  onChange: (next: CustomFieldMapping) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="flex gap-2">
        <Input
          value={field.name}
          onChange={(e) => onChange({ ...field, name: e.target.value })}
          placeholder="Field name (e.g. Scan Code)"
          className="text-sm"
        />
        <Input
          value={field.template}
          onChange={(e) => onChange({ ...field, template: e.target.value })}
          placeholder="Template (e.g. {toteId})"
          className="font-mono text-sm"
        />
        <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label="Remove field">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {preview && (
        <div className="mt-1.5 rounded border border-border/50 bg-background px-2 py-1 text-xs text-muted-foreground">
          <span className="mr-1 text-[10px] uppercase tracking-wider text-primary">preview</span>
          <span className="whitespace-pre-wrap">{preview}</span>
        </div>
      )}
    </div>
  );
}


function VarChips({ vars }: { vars: string[] }) {
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {vars.map((v) => (
        <code key={v} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {`{${v}}`}
        </code>
      ))}
    </div>
  );
}

function MappingField({
  label,
  value,
  onChange,
  preview,
  multiline,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  preview: string;
  multiline?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="mb-4">
      <Label className="mb-1.5 block text-xs uppercase tracking-wide text-muted-foreground">{label}</Label>
      {multiline ? (
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} placeholder={placeholder} className="font-mono text-sm" />
      ) : (
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="font-mono text-sm" />
      )}
      {preview && (
        <div className="mt-1.5 rounded border border-border/50 bg-background px-2 py-1.5 text-xs text-muted-foreground">
          <span className="mr-1 text-[10px] uppercase tracking-wider text-primary">preview</span>
          <span className="whitespace-pre-wrap">{preview}</span>
        </div>
      )}
    </div>
  );
}

function ConnectionCard({
  conn,
  setConn,
  client,
  handleConnect,
  existingLocations,
  running,
}: {
  conn: { baseUrl: string; username: string; password: string; token: string };
  setConn: (c: { baseUrl: string; username: string; password: string; token: string }) => void;
  client: HomeboxClient | null;
  handleConnect: () => void;
  existingLocations: HomeboxLocation[];
  running: boolean;
}) {
  return (
    <div className="space-y-3">
      <div>
        <Label className="mb-1.5 block text-xs uppercase tracking-wide text-muted-foreground">Homebox URL</Label>
        <Input placeholder="https://homebox.local" value={conn.baseUrl} onChange={(e) => setConn({ ...conn, baseUrl: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="mb-1.5 block text-xs uppercase tracking-wide text-muted-foreground">Username</Label>
          <Input value={conn.username} onChange={(e) => setConn({ ...conn, username: e.target.value })} />
        </div>
        <div>
          <Label className="mb-1.5 block text-xs uppercase tracking-wide text-muted-foreground">Password</Label>
          <Input type="password" value={conn.password} onChange={(e) => setConn({ ...conn, password: e.target.value })} />
        </div>
      </div>
      <Button className="w-full" onClick={handleConnect} disabled={running}>
        {client ? "Reconnect" : "Connect"}
      </Button>
      {client && (
        <div className="rounded-md border border-primary/40 bg-primary/10 p-3 text-xs">
          <p className="font-medium text-primary">Connected</p>
          <p className="mt-0.5 text-muted-foreground">
            {existingLocations.length} existing locations on server.
          </p>
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        This app calls the Homebox API directly from your browser. If you see CORS errors, make sure your Homebox instance allows requests from this app's origin.
      </p>
    </div>
  );
}

function ImportRunner({
  client,
  totalTotes,
  totalItems,
  logs,
  progress,
  running,
  done,
  onRun,
}: {
  client: HomeboxClient | null;
  totalTotes: number;
  totalItems: number;
  logs: LogEntry[];
  progress: number;
  running: boolean;
  done: boolean;
  onRun: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border/60 bg-background/60 p-3 text-sm">
        <p className="mb-2 font-medium">Ready to import</p>
        <ul className="space-y-1 text-muted-foreground">
          <li>{totalTotes} totes → locations</li>
          <li>{totalItems} items</li>
        </ul>
      </div>
      <Button className="w-full" size="lg" onClick={onRun} disabled={!client || running || totalItems === 0}>
        {running ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Importing…</> : done ? "Run again" : "Start import"}
      </Button>
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Progress</span>
          <span className="text-xs text-muted-foreground">{progress}%</span>
        </div>
        <Progress value={progress} className="mb-3" />
        <ScrollArea className="h-[280px] rounded border border-border/60 bg-background/60 p-3 font-mono text-xs">
          {logs.length === 0 ? (
            <p className="text-muted-foreground">Logs will appear here once the import starts.</p>
          ) : (
            <ul className="space-y-1">
              {logs.map((l, i) => (
                <li key={i} className="flex gap-2">
                  {l.level === "ok" && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />}
                  {l.level === "error" && <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />}
                  {l.level === "info" && <div className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                  <span className={l.level === "error" ? "text-destructive" : "text-foreground/90"}>{l.text}</span>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}


function DiagnosticsPanel({ entries, onClear, client }: { entries: DiagnosticEntry[]; onClear: () => void; client: HomeboxClient | null }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [cookieTest, setCookieTest] = useState<{ status: number; ok: boolean } | null>(null);
  const [testing, setTesting] = useState(false);
  const filtered = onlyErrors ? entries.filter((e) => !e.ok) : entries;
  const errCount = entries.filter((e) => !e.ok).length;

  // Cookie diagnostics summary (best-effort — browsers hide Set-Cookie and the
  // Cookie header from JS for cross-origin fetches, so we infer from what we
  // CAN see and offer an explicit cookie-only auth probe).
  const loginEntry = [...entries].reverse().find((e) => /users\/login/.test(e.url));
  const lastEntry = entries[entries.length - 1];
  const setCookieVisible = loginEntry?.responseHeaders?.["set-cookie"];
  const acaCredentials =
    loginEntry?.responseHeaders?.["access-control-allow-credentials"] ??
    lastEntry?.responseHeaders?.["access-control-allow-credentials"];
  const acaOrigin =
    loginEntry?.responseHeaders?.["access-control-allow-origin"] ??
    lastEntry?.responseHeaders?.["access-control-allow-origin"];
  const visibleHbCookies =
    typeof document !== "undefined"
      ? document.cookie.split(";").map((c) => c.trim()).filter((c) => c.startsWith("hb.auth."))
      : [];

  async function runCookieTest() {
    if (!client) return;
    setTesting(true);
    try {
      const r = await client.testCookieOnlyAuth();
      setCookieTest(r);
      if (r.ok) toast.success("Cookie-only auth succeeded");
      else toast.error(`Cookie-only auth failed (${r.status})`);
    } catch (e) {
      toast.error(`Test failed: ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  }

  function copyAll() {
    const text = entries
      .map(
        (e) =>
          `[${e.timestamp}] (${e.phase}) ${e.method} ${e.url} → ${e.status ?? "ERR"} ${e.statusText ?? ""} (${e.durationMs}ms)\n` +
          `req headers: ${JSON.stringify(e.requestHeaders)}\n` +
          (e.requestBody ? `req body: ${e.requestBody}\n` : "") +
          (e.responseHeaders ? `res headers: ${JSON.stringify(e.responseHeaders)}\n` : "") +
          (e.responseBody ? `res body: ${e.responseBody}\n` : "") +
          (e.error ? `error: ${e.error}\n` : ""),
      )
      .join("\n---\n");
    navigator.clipboard?.writeText(text).then(
      () => toast.success("Diagnostics copied to clipboard"),
      () => toast.error("Copy failed"),
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Diagnostics</h2>
          <p className="text-xs text-muted-foreground">
            {entries.length} Homebox request{entries.length === 1 ? "" : "s"}
            {errCount > 0 && <span className="text-destructive"> · {errCount} failed</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={onlyErrors} onCheckedChange={setOnlyErrors} />
            Errors only
          </label>
          <Button variant="outline" size="sm" onClick={copyAll} disabled={entries.length === 0}>
            Copy
          </Button>
          <Button variant="ghost" size="sm" onClick={onClear} disabled={entries.length === 0}>
            Clear
          </Button>
        </div>
      </div>

      <div className="mb-3 rounded-md border border-border/60 bg-background/60 p-3 text-xs">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="font-semibold uppercase tracking-wider text-muted-foreground">Cookie auth</p>
          <Button size="sm" variant="outline" onClick={runCookieTest} disabled={!client || testing}>
            {testing ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
            Test cookie-only auth
          </Button>
        </div>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
          <dt className="text-muted-foreground">login Set-Cookie</dt>
          <dd className="break-all">
            {loginEntry
              ? setCookieVisible
                ? setCookieVisible
                : <span className="text-muted-foreground">not visible to JS (normal for cross-origin / HttpOnly)</span>
              : <span className="text-muted-foreground">no login recorded yet</span>}
          </dd>
          <dt className="text-muted-foreground">ACA-Credentials</dt>
          <dd className={acaCredentials === "true" ? "text-primary" : "text-destructive"}>
            {acaCredentials ?? "missing — Homebox must send Access-Control-Allow-Credentials: true"}
          </dd>
          <dt className="text-muted-foreground">ACA-Origin</dt>
          <dd className={acaOrigin && acaOrigin !== "*" ? "text-primary" : "text-destructive"}>
            {acaOrigin ?? "missing"} {acaOrigin === "*" && "(must echo specific origin, not *, for cookies)"}
          </dd>
          <dt className="text-muted-foreground">document.cookie</dt>
          <dd className="break-all">
            {visibleHbCookies.length > 0
              ? visibleHbCookies.join("; ")
              : <span className="text-muted-foreground">no hb.auth.* cookies visible (HttpOnly cookies are hidden from JS — this is expected)</span>}
          </dd>
          <dt className="text-muted-foreground">cookie-only probe</dt>
          <dd className={cookieTest ? (cookieTest.ok ? "text-primary" : "text-destructive") : "text-muted-foreground"}>
            {cookieTest
              ? `${cookieTest.ok ? "SUCCESS" : "FAILED"} — GET /api/v1/users/self without Bearer → ${cookieTest.status}`
              : "not run yet — click the button to verify cookies alone authenticate"}
          </dd>
        </dl>
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          Browsers do not expose Set-Cookie response headers or the outgoing Cookie header to JavaScript for cross-origin requests, so the only reliable check is the cookie-only probe above.
        </p>
      </div>

      <ScrollArea className="h-[360px] rounded border border-border/60 bg-background/60">
        {filtered.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            No requests yet. Connect to Homebox or start the import to capture request/response details here.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {filtered.map((e) => {
              const open = openId === e.id;
              return (
                <li key={e.id} className="text-xs">
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : e.id)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40"
                  >
                    <span
                      className={`inline-flex h-5 min-w-[42px] items-center justify-center rounded px-1.5 font-mono text-[10px] font-semibold ${
                        e.ok
                          ? "bg-success/15 text-success"
                          : "bg-destructive/15 text-destructive"
                      }`}
                    >

                      {e.status ?? "ERR"}
                    </span>
                    <span className="font-mono text-[11px] font-semibold uppercase text-muted-foreground">{e.method}</span>
                    <span className="flex-1 truncate font-mono">{e.url.replace(/^https?:\/\/[^/]+/, "")}</span>
                    <span className="shrink-0 text-muted-foreground">{e.durationMs}ms</span>
                  </button>
                  {open && (
                    <div className="space-y-3 border-t border-border/60 bg-background/80 p-3 font-mono">
                      <DiagRow label="phase" value={e.phase} />
                      <DiagRow label="time" value={e.timestamp} />
                      <DiagRow label="url" value={e.url} />
                      {e.error && <DiagBlock label="error" body={e.error} tone="error" />}
                      <DiagBlock label="request headers" body={JSON.stringify(e.requestHeaders, null, 2)} />
                      {e.requestBody && <DiagBlock label="request body" body={e.requestBody} />}
                      {e.responseHeaders && (
                        <DiagBlock label="response headers" body={JSON.stringify(e.responseHeaders, null, 2)} />
                      )}
                      {e.responseBody && (
                        <DiagBlock label="response body" body={e.responseBody} tone={e.ok ? undefined : "error"} />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

function DiagRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-[11px]">
      <span className="w-28 shrink-0 uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="break-all">{value}</span>
    </div>
  );
}

function DiagBlock({ label, body, tone }: { label: string; body: string; tone?: "error" }) {
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <pre
        className={`max-h-56 overflow-auto whitespace-pre-wrap break-all rounded border border-border/60 bg-background p-2 text-[11px] ${
          tone === "error" ? "text-destructive" : "text-foreground/90"
        }`}
      >
        {body}
      </pre>
    </div>
  );
}

function NavButtons({ onBack, onNext, nextLabel, nextDisabled }: { onBack: () => void; onNext: () => void; nextLabel: string; nextDisabled?: boolean }) {
  return (
    <div className="mt-8 flex items-center justify-between">
      <Button variant="outline" onClick={onBack}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back
      </Button>
      <Button onClick={onNext} disabled={nextDisabled}>
        {nextLabel} <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
    </div>
  );
}
