# ADR-006: Map Data — OpenStreetMap → Internal Graph

- **Status**: Accepted
- **Date**: 2026-05-19
- **Deciders**: Project lead
- **Source**: the project's original architecture decision set (ADR-001 … ADR-009, this directory)

## Context

The simulator must model a realistic city — real road geometry, lane
connectivity, intersection topology, traffic-signal timing. Hand-authoring
this for any non-trivial city is infeasible. OpenStreetMap (OSM) is the
de-facto open data source for road networks and is freely available for
most of the planet.

## Decision

Adopt **OSM (`.osm` / `.pbf`) as the source-of-truth map format**, parsed
by `app/apps/maps/` into an **internal graph structure** (nodes =
intersections + way-points; edges = road segments; attributes = lanes,
speed limits, turn restrictions, traffic-signal phasing). The internal
graph is what the rest of the system (renderer, RL env, planner) reads;
OSM is the persistence format.

## Consequences

- The OSM parser is a one-time write, not a hot path; it lives in
  `app/apps/maps/osm_parser.py` and produces a JSON-serializable
  `RoadNetwork` value object consumed by the Gymnasium env.
- The A* / Dijkstra path planner sits on top of the internal graph,
  not on raw OSM data — so the env can re-plan on signal phase
  changes without re-parsing.
- The frontend renders the internal graph via Three.js line segments;
  no raw OSM rendering.
- This ADR is forward-compatible with future map sources (e.g.
  OpenDRIVE, lanelet2) by swapping the parser only.

## Alternatives considered

- **Hand-authored road networks**: only viable for tiny test scenes.
- **Google Maps / Here / TomTom data**: licensing cost and
  attribution requirements are out of scope for this project.
- **Lanelet2 (autonomous-driving format)**: technically richer for
  lanelet-level modeling, but the OSM ecosystem tooling (osmium,
  OSMnx) is more accessible and the additional fidelity is not
  needed at the current scope.
