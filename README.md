# BigBoss Live

A live-streaming social platform: go live on video or in party (audio) rooms, send gifts, battle
other hosts in PK, play provably-fair mini-games, and chat. It ships with a production backend, an
admin dashboard and a Flutter app, all in a warm **Champagne** look: ivory surfaces, deep gold and
bronze.

| Component | Tech | Location |
|---|---|---|
| Mobile app | Flutter 3, Riverpod, go_router, LiveKit, Firebase | [`app/`](app/README.md) |
| API server | Node 22, TypeScript, Express 5, MongoDB (replica set), Redis, Socket.IO, BullMQ, LiveKit | [`backend/`](backend) |
| Admin dashboard | React 19, Vite, Ant Design 6, TanStack Query | [`admin/`](admin) |
| Mini-games | Vite + TypeScript (Canvas/CSS) in a WebView | [`games/`](games) |
| Shared contracts | TypeScript types, socket events, design tokens | [`packages/shared/`](packages/shared) |
| Infra | docker-compose (Mongo RS, Redis, LiveKit), nginx example, CI | [`infra/`](infra), [`.github/`](.github) |

## Quick start (local)

```bash
nvm use                       # Node 22
npm ci                        # installs every JS workspace
npm run build:shared

# Infra: MongoDB replica set + Redis + LiveKit dev server + API
docker compose -f infra/docker-compose.yml up -d mongo redis livekit

cp backend/.env.example backend/.env    # fill FIREBASE_*, LIVEKIT_*, S3_* as needed
npm run dev:backend                      # http://localhost:3000  (/docs for the API reference)
npm run seed -w backend                  # levels, gifts, VIP, cosmetics, packages, games
npm run seed:demo -w backend             # optional demo users/activity (never in production)
npm run set-admin -w backend -- you@example.com superadmin

cp admin/.env.example admin/.env && npm run dev:admin     # http://localhost:5173
cp games/.env.example games/.env && npm run dev:games     # http://localhost:5174

cd app && flutter pub get && flutter run   # see app/README.md for Firebase files
```

## Quality gates

```bash
npm run lint && npm run format:check && npm run typecheck
npm test -w backend            # integration tests on an in-memory MongoDB replica set
npm run build -w admin && npm run build -w games
cd app && flutter analyze && flutter test
```

All of these run in CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), along with a
Docker build of the API and `npm audit`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): components, data flow, invariants, realtime, jobs
- [Deployment](docs/DEPLOYMENT.md): production setup, configuration, scaling, operations
- [Coolify on a Hostinger VPS](docs/COOLIFY.md): step-by-step self-hosted deployment
- [Design system](docs/DESIGN_SYSTEM.md): the Champagne palette, typography and usage rules
- [Games & fairness](docs/GAMES.md): round engine, provably-fair RNG, RTP
- [API reference](docs/openapi.yaml): served at `/docs` on non-production servers
- [CLAUDE.md](CLAUDE.md): conventions and rules for contributors and coding agents
