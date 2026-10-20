# TraffSim3D Frontend

Vue 3 + Vite + Three.js + Pinia. DDD-layered — see
`../docs/` §3.2 for the structure spec.

## Develop

```sh
npm install
npm run dev          # http://localhost:5173/
```

The interesting route is `/scene-editor` — landing `/` is a showcase.

## Build

```sh
npm run build        # outputs dist/
npm run preview      # serves dist/
```

## Lint / format

```sh
npm run lint         # ESLint flat config
npm run format       # Prettier write
```

## Test

No test runner is wired up yet. A future plan will add Vitest with
tests for the pure functions in `src/domain/value-objects/`, the
serializer in `src/infrastructure/persistence/`, and the `tick` step
function in `src/application/services/`.

## Architecture cheat sheet

| Layer          | Path                  | Imports from                        |
| -------------- | --------------------- | ----------------------------------- |
| Domain         | `src/domain/`         | nothing (pure)                      |
| Application    | `src/application/`    | domain                              |
| Infrastructure | `src/infrastructure/` | domain, three, browser APIs         |
| Interfaces     | `src/interfaces/`     | application, infrastructure, shared |
| Shared         | `src/shared/`         | nothing                             |
