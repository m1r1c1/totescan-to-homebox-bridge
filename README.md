# Totescan → Homebox Migrator

A self-hostable web app that converts a **Totescan MHTML export** into locations, items, and photos in your **Homebox** instance via the Homebox API.

Everything runs client-side in your browser: the MHTML is parsed locally, and API calls go directly from your browser to your Homebox server. No data leaves your network.

## Features

- Upload `.mhtml` / `.mht` / `.html` Totescan exports
- Preview parsed totes and items, pick which ones to import
- Configurable **field mapping** with `{variable}` templates (add/remove/edit)
- Deduplicates against existing Homebox locations by name
- Optional image upload (fetches originals from Totescan's S3 and attaches to items)
- Live progress log

## Running on TrueNAS with Docker

Build the image and run it as a container:

```bash
docker build -t totescan-to-homebox .
docker run -d --name totescan-migrator -p 3000:3000 --restart unless-stopped totescan-to-homebox
```

Then open `http://<truenas-ip>:3000` in your browser.

### docker-compose

```yaml
services:
  migrator:
    build: .
    ports:
      - "3000:3000"
    restart: unless-stopped
```

## CORS

The app calls your Homebox API from the browser. If your Homebox instance rejects the request with a CORS error, either:

1. Serve both apps from the same origin (reverse proxy), or
2. Configure Homebox to allow the migrator's origin in `HBOX_OPTIONS_ALLOWED_URLS` (see Homebox docs).

## Field mapping variables

**Tote-level:** `{toteId}` `{title}` `{location}` `{profile}` `{parentToteId}` `{dateUpdated}`

**Item-level (also includes tote vars):** `{name}` `{itemNumber}` `{quantity}` `{description}` `{upc}`
