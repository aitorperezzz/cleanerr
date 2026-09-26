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
npm start
```

Open <http://localhost:3050>. A new installation opens Settings, where each
service can be configured and tested independently.

## Configuration

The Settings page stores these six values:

- Radarr URL and API key
- Sonarr URL and API key
- Jellyfin URL and API key

Every service has separate **Test connection** and **Save** actions. Saved API
keys are never sent back to the browser; leave the API key field empty to keep
the existing value. Jellyfin can be configured and tested now, although its
library is not yet displayed by Cleanerr. After Cleanerr deletes media through
Radarr or Sonarr, it asks Jellyfin to refresh its library. Closely timed deletes
are grouped into a single refresh, and a Jellyfin error does not change the
result of a deletion that already completed.

During local development, settings are written to `data/config.json`. The
Docker image sets `NODE_ENV=production`, which changes the location to
`/data/config.json` so the complete `/data` directory can be mounted as a
persistent volume. `CLEANERR_DATA_DIR` can optionally override the directory in
unusual deployments; normal local and Docker usage does not need it.

The web server always listens on `0.0.0.0:3050`. These internal values live in
the committed application [config.json](config.json), not in the Settings page.
Developers can temporarily edit that file locally if necessary.

## Docker

Build and run the container with Docker Compose:

```sh
docker compose up --build -d
```

Compose publishes Cleanerr at <http://localhost:3050> and keeps its settings in
the `cleanerr-data` volume. To expose a different host port, change only the
left side of the mapping, for example `8080:3050`.

To use an image from a registry instead of building locally:

```sh
IMAGE=registry.example.com/group/cleanerr:latest docker compose up -d
```

Service URLs and API keys are created at runtime in `/data/config.json`; they
are never stored in the image.

## GitLab CI

The GitLab pipeline follows the Buildah-based setup used by the Minesweeper
project. A commit on `main` builds the image and pushes both of these tags to
the GitLab Container Registry:

- `$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA`
- `$CI_REGISTRY_IMAGE:latest`

The pipeline uses GitLab's predefined registry variables, so no Radarr or
Sonarr credentials are needed during the image build. Runtime configuration
is entered through Settings after the container is deployed.

## Security

The runtime `data/` directory is excluded from Git and from the Docker build
context. Do not commit `/data/config.json` or expose API keys in screenshots,
logs, issues, or pull requests. Anyone who can access Settings can replace the
service configuration, so place Cleanerr behind the same access controls used
for the rest of your media services.

## Development

The server uses Node.js without a build step and serves the files in `public/`.
After changing server-side code, restart `npm start`. Browser assets can be
refreshed directly. The same Node.js major version is used for local development
and the container image.

Run the automated test suite with:

```sh
npm test
```

The tests use Node.js's built-in test runner and do not connect to real Radarr,
Sonarr, or Jellyfin instances. Service calls are replaced with in-memory fakes,
including destructive operations.

The main modules are organized as follows:

- `server.js` contains HTTP routing and service transport.
- `library-actions.js` contains monitoring and deletion workflows.
- `radarr-snapshot.js` coalesces concurrent Radarr library reads.
- `settings-store.js` validates and persists runtime configuration.
- `public/library-utils.js` contains reusable formatting, search, and sorting logic.
