# Cleanerr

Cleanerr is a small web application for reviewing the disk space used by a
Radarr and Sonarr library. It can sort movies, series, seasons, and Radarr
collections by size and perform monitoring or deletion actions from one place.

> [!WARNING]
> Some actions delete media files from disk through Radarr or Sonarr. Review
> every confirmation carefully. Cleanerr does not provide an undo function.

## Requirements

- Node.js 26
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

## Docker

Build and run the container with Docker Compose:

```sh
cp .env.example .env
# Edit .env before starting the container.
docker compose up --build -d
```

Compose publishes Cleanerr on the port configured by `PORT` in `.env`. Inside
the container, the server always listens on `0.0.0.0:3000`, while Radarr and
Sonarr connection details are passed from `.env` at runtime.

To use an image from a registry instead of building locally:

```sh
IMAGE=registry.example.com/group/cleanerr:latest docker compose up -d
```

The `.env` file is excluded from the Docker build context, so service API keys
are not stored in the image.

## GitLab CI

The GitLab pipeline follows the Buildah-based setup used by the Minesweeper
project. A commit on `main` builds the image and pushes both of these tags to
the GitLab Container Registry:

- `$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA`
- `$CI_REGISTRY_IMAGE:latest`

The pipeline uses GitLab's predefined registry variables, so no Radarr or
Sonarr credentials are needed during the image build. Runtime configuration
must be supplied when the container is deployed.

## Security

The real `.env` file is excluded from Git. Do not commit it or expose the API
keys in screenshots, logs, issues, or pull requests. Use `.env.example` as the
safe configuration template.

## Development

The server uses Node.js without a build step and serves the files in `public/`.
After changing server-side code, restart `npm start`. Browser assets can be
refreshed directly. The same Node.js major version is used for local development
and the container image.
