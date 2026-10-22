# TraffSim3D Frontend

Vue 3 + Vite + Three.js + Pinia. DDD-layered — `src/` is split into
domain / application / infrastructure / interfaces / shared (see below).

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

```sh
npm run test:run           # Vitest unit tests
npm run test:coverage      # + coverage (thresholds are enforced)
npm run test:e2e           # Playwright end-to-end + visual regression
npm run contract:check     # cross-language contract snapshots
```

Unit tests (736 across 55 files) cover the pure functions in `src/domain/`,
the serializer in `src/infrastructure/persistence/`, the `tick` step function in
`src/application/services/` and the controllers. The end-to-end suite (41
Playwright tests) drives a live dev server and compares screenshots against the
baselines in `../e2e-output/baseline/`.

Coverage of the **views** is uneven, and worth knowing before you rely on it:
only the AI Playground has view-level specs (`AIPlaygroundView.spec.ts`,
`AIPlaygroundTrainingCurve.spec.ts`). The other screens are covered by
end-to-end specs — except `/simulation-lab`, `/backend` and `/deliverables`,
which currently have **no** view-level test at all.

## Architecture cheat sheet

| Layer          | Path                  | Imports from                        |
| -------------- | --------------------- | ----------------------------------- |
| Domain         | `src/domain/`         | nothing (pure)                      |
| Application    | `src/application/`    | domain                              |
| Infrastructure | `src/infrastructure/` | domain, three, browser APIs         |
| Interfaces     | `src/interfaces/`     | application, infrastructure, shared |
| Shared         | `src/shared/`         | nothing                             |
