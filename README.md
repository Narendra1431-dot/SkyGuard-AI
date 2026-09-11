# SkyGuard Environmental Dashboard

This workspace contains the existing dashboard UI in `Html.html` and a Node.js backend in `env-dashboard/backend`.

## Local run

```powershell
Set-Location .\env-dashboard\backend
npm install
npm start
```

Open `Html.html` in a browser after the backend starts. The page reads live station snapshots from `http://localhost:4000` and receives incremental updates over Socket.io. Local startup uses the bounded in-memory store by default, so InfluxDB is optional.

## Docker run

```powershell
Set-Location .\env-dashboard
docker compose up --build
```

The backend is available at `http://localhost:4000`; InfluxDB is available at `http://localhost:8086`.

## API

- `GET /api/v1/health`
- `GET /api/v1/dashboard`
- `GET /api/v1/stations`
- `GET /api/v1/readings?stationId=HYD001&minutes=60`
- `GET /api/v1/history?stationId=HYD001&field=temperature&minutes=30`
- `GET /api/v1/anomalies?minutes=1440`
- `GET /api/v1/alerts`
- `GET /api/v1/maintenance`
- `GET /api/v1/architecture`
- `POST /api/v1/assistant` with `{ "query": "What is the current AQI in Hyderabad?" }`

Socket.io events include `sensor:update`, `dashboard:update`, `station:status`, `anomaly:new`, `alert:new`, and `system:update`.

## Configuration

Copy `backend/.env.example` to `backend/.env` when overriding local settings. Do not commit real InfluxDB tokens. `USE_INFLUXDB=false` is the default for local development; set it to `true` only when a reachable InfluxDB instance is configured.

## Current limitations

The repository currently has one static HTML client and no relational database, report worker, trained ML model, authentication, or automated test suite. The health endpoint reports ML and report services as `UNAVAILABLE` rather than fabricating metrics. The simulator is backend-only and uses the same validation, persistence, analysis, and broadcast path as future sensor input.
