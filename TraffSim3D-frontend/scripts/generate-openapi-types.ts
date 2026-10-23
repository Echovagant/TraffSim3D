// scripts/generate-openapi-types.ts
//
// Generate TypeScript types from the backend's committed OpenAPI
// schema (`docs/openapi.json`).
//
// Run:  npm run api:types        (write)
//       npm run api:types:check  (verify the generated file is up to date)
//
// WHY THIS EXISTS
// ---------------
// The frontend used to hand-write its API types and cast the backend's
// JSON with `as Status`. A cast is a *promise* the compiler cannot
// check: when the backend renames a field, `as Status` keeps compiling
// and the browser shows a plausible but wrong number. Generating the
// types from the committed schema makes the drift visible in a diff —
// and `api:types:check` turns it into a CI failure.
//
// LIMITATION (deliberate, not a bug in the generator)
// ---------------------------------------------------
// The backend declares most of its endpoints as `-> dict[str, Any]`
// (e.g. `app/api/v1/rl.py::status`). FastAPI cannot describe that, so
// the schema says `additionalProperties: true` with **no properties**.
// The generated type for such an endpoint is `Record<string, unknown>`
// — honest, but not field-level. Those endpoints get a hand-written,
// runtime-validated contract instead (see `src/infrastructure/api/rlStatus.ts`).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(FRONTEND_ROOT, '..')
const SCHEMA_PATH = resolve(REPO_ROOT, 'docs', 'openapi.json')
const OUT_PATH = resolve(FRONTEND_ROOT, 'src', 'infrastructure', 'api', 'generated', 'openapi.ts')

interface JsonSchema {
  [key: string]: unknown
}

const isSchema = (v: unknown): v is JsonSchema =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** `Body_parse_osm_api_v1_maps_parse_osm_post` → a valid TS identifier. */
const safeIdent = (raw: string): string => {
  const cleaned = raw.replace(/[^A-Za-z0-9_$]+/g, '_').replace(/^_+/, '')
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
}

/** `/api/v1/rl/status` → `ApiV1RlStatus` (PascalCase, path separators dropped). */
const pascalPath = (path: string): string =>
  path
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')

const refName = (ref: string): string => safeIdent(ref.split('/').pop() ?? 'Unknown')

/**
 * JSON Schema → TypeScript.
 *
 * Only the subset FastAPI actually emits is supported: objects,
 * arrays, scalars, enums, `$ref`, `anyOf` / `oneOf` / `allOf`.
 */
const tsType = (schema: JsonSchema | undefined, indent: string): string => {
  if (!isSchema(schema)) return 'unknown'
  if (typeof schema.$ref === 'string') return refName(schema.$ref)

  for (const key of ['anyOf', 'oneOf'] as const) {
    const list = schema[key]
    if (Array.isArray(list) && list.length > 0) {
      return list.map((s) => tsType(s as JsonSchema, indent)).join(' | ')
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.map((s) => tsType(s as JsonSchema, indent)).join(' & ')
  }

  const t = schema.type
  if (t === 'string') {
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return schema.enum.map((v) => JSON.stringify(v)).join(' | ')
    }
    return 'string'
  }
  if (t === 'integer' || t === 'number') return 'number'
  if (t === 'boolean') return 'boolean'
  if (t === 'null') return 'null'
  if (t === 'array') {
    return `Array<${tsType(schema.items as JsonSchema | undefined, indent)}>`
  }
  if (t === 'object' || schema.properties !== undefined) {
    const props = schema.properties
    if (!isSchema(props) || Object.keys(props).length === 0) {
      const addl = schema.additionalProperties
      if (isSchema(addl)) return `Record<string, ${tsType(addl, indent)}>`
      return 'Record<string, unknown>'
    }
    const required = new Set<string>(
      Array.isArray(schema.required) ? (schema.required as string[]) : [],
    )
    const lines = Object.entries(props).map(([key, value]) => {
      const optional = required.has(key) ? '' : '?'
      const propKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key)
      return `${indent}  ${propKey}${optional}: ${tsType(value as JsonSchema, indent + '  ')}`
    })
    return `{\n${lines.join('\n')}\n${indent}}`
  }
  return 'unknown'
}

/** `/api/v1/rl/status` → `PathsApiV1RlStatusGet`. */
const operationTypeName = (path: string, method: string): string =>
  `Paths${pascalPath(path)}${method.charAt(0).toUpperCase()}${method.slice(1)}`

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const

const build = (schema: JsonSchema): string => {
  const components = isSchema(schema.components) ? schema.components : {}
  const schemas = isSchema(components.schemas) ? components.schemas : {}

  const out: string[] = []
  out.push('// ============================================================')
  out.push('// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.')
  out.push('//')
  out.push("// Source:      docs/openapi.json (the backend's committed schema)")
  out.push('// Generator:  scripts/generate-openapi-types.ts')
  out.push('// Regenerate: npm run api:types')
  out.push('// Verify:     npm run api:types:check')
  out.push('//')
  out.push('// Endpoints the backend declares as `dict[str, Any]` have no')
  out.push('// properties in the schema, so their generated response type is')
  out.push('// `Record<string, unknown>`. Those endpoints carry a hand-written,')
  out.push('// runtime-validated contract instead — see')
  out.push('// `src/infrastructure/api/rlStatus.ts`.')
  out.push('// ============================================================')
  out.push('')

  // --- component schemas ---
  for (const [name, value] of Object.entries(schemas)) {
    const body = tsType(value as JsonSchema, '')
    if (body.startsWith('{')) {
      out.push(`/** \`${name}\` — from the OpenAPI \`components.schemas\`. */`)
      out.push(`export interface ${safeIdent(name)} ${body}`)
    } else {
      out.push(`/** \`${name}\` — from the OpenAPI \`components.schemas\`. */`)
      out.push(`export type ${safeIdent(name)} = ${body}`)
    }
    out.push('')
  }

  // --- operations ---
  const paths = isSchema(schema.paths) ? schema.paths : {}
  /** path → the methods declared for it (a path can carry several). */
  const pathMethods = new Map<string, string[]>()
  for (const [path, item] of Object.entries(paths)) {
    if (!isSchema(item)) continue
    for (const method of METHODS) {
      const op = item[method]
      if (!isSchema(op)) continue
      const responses = isSchema(op.responses) ? op.responses : {}
      const ok = responses['200'] ?? responses['201'] ?? responses['204']
      const content = isSchema(ok) ? ok.content : undefined
      const json = isSchema(content) ? content['application/json'] : undefined
      const responseSchema = isSchema(json) ? json.schema : undefined
      const typeName = `${operationTypeName(path, method)}Response`
      out.push(`/** \`${method.toUpperCase()} ${path}\` → 200 */`)
      out.push(`export type ${typeName} = ${tsType(responseSchema, '')}`)
      out.push('')
      const methods = pathMethods.get(path) ?? []
      methods.push(method)
      pathMethods.set(path, methods)
    }
  }

  out.push('/**')
  out.push(' * Every operation the backend exposes, keyed by path and method.')
  out.push(' *')
  out.push(" * Usage: `type S = OpenApiPaths['/api/v1/rl/status']['get']`")
  out.push(' */')
  out.push('export interface OpenApiPaths {')
  const pathLines: string[] = []
  for (const [path, methods] of pathMethods) {
    const members = methods.map((m) => `${m}: ${operationTypeName(path, m)}Response`)
    pathLines.push(`  ${JSON.stringify(path)}: { ${members.join('; ')} }`)
  }
  out.push(pathLines.join('\n'))
  out.push('}')
  out.push('')
  out.push('/** The response body type of one operation. */')
  out.push(
    'export type ResponseOf<P extends keyof OpenApiPaths, M extends keyof OpenApiPaths[P]> =',
  )
  out.push('  OpenApiPaths[P][M]')
  out.push('')

  return out.join('\n')
}

const main = (argv: string[]): number => {
  const check = argv.includes('--check')

  if (!existsSync(SCHEMA_PATH)) {
    console.error(`[openapi-types] MISSING ${SCHEMA_PATH}`)
    return 1
  }
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8')) as JsonSchema
  const generated = build(schema)

  if (check) {
    if (!existsSync(OUT_PATH)) {
      console.error(`[openapi-types] MISSING ${OUT_PATH} — run \`npm run api:types\`.`)
      return 1
    }
    const current = readFileSync(OUT_PATH, 'utf-8')
    if (current !== generated) {
      console.error(
        `[openapi-types] DRIFT ${OUT_PATH} differs from docs/openapi.json. ` +
          'Run `npm run api:types` and commit the result.',
      )
      return 1
    }
    console.log(`[openapi-types] OK ${OUT_PATH} is up to date.`)
    return 0
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, generated, 'utf-8')
  console.log(`[openapi-types] wrote ${OUT_PATH}`)
  return 0
}

process.exit(main(process.argv.slice(2)))
