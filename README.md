# Cleanerr

Cleanerr is a small web application for reviewing the disk space used by a
Radarr and Sonarr library. It can sort movies, series, seasons, and Radarr
collections by size and perform monitoring or deletion actions from one place.

> [!WARNING]
> Some actions delete media files from disk through Radarr or Sonarr. Review
> every confirmation carefully. Cleanerr does not provide an undo function.

## Requirements

- Node.js 18 or newer
- A reachable Radarr instance
- A reachable Sonarr instance
- API keys with permission to read and modify those instances
- `curl` is recommended as a fallback when Node.js cannot complete a request

## Installation

```sh
npm install
cp .env.example .env
```

Edit `.env` with the addresses and API keys for your services, then start the
application:

```sh
npm start
```

By default, the example configuration makes the interface available at
<http://127.0.0.1:3000>.

## Configuration

All deployment-specific configuration is loaded from `.env`:

| Variable | Required | Description |
| --- | --- | --- |
| `HOST` | Yes | Address on which Cleanerr listens. |
| `PORT` | Yes | Port on which Cleanerr listens. |
| `RADARR_URL` | Yes | Base URL of the Radarr instance. |
| `RADARR_API_KEY` | Yes | Radarr API key. |
| `SONARR_URL` | Yes | Base URL of the Sonarr instance. |
| `SONARR_API_KEY` | Yes | Sonarr API key. |
| `JELLYFIN_URL` | No | Reserved for a future Jellyfin integration. |
| `JELLYFIN_API_KEY` | No | Reserved for a future Jellyfin integration. |

Example:

```dotenv
HOST=127.0.0.1
PORT=3000

RADARR_URL=http://radarr:7878
RADARR_API_KEY=replace-with-your-radarr-api-key

SONARR_URL=http://sonarr:8989
SONARR_API_KEY=replace-with-your-sonarr-api-key
```

The application validates required variables during startup and stops with a
clear error if any value is missing or invalid. A trailing slash in a service
URL is removed automatically.

Jellyfin is not currently used by the application. Its variables are included
so its connection details can remain centralized when that integration is
implemented.

## Security

The real `.env` file is excluded from Git. Do not commit it or expose the API
keys in screenshots, logs, issues, or pull requests. Use `.env.example` as the
safe configuration template.

## Development

The server uses Node.js without a build step and serves the files in `public/`.
After changing server-side code, restart `npm start`. Browser assets can be
refreshed directly.
