## F-D2 Data Schema Analysis `[TODO]`

Use the API documented in F-D1 to fetch real parking data and analyze its structure. This is what a developer would do before designing TypeScript types.

### F-D2.1 Fetch and Document the Schema

Make a real HTTP request to the API using the endpoint and headers from `docs/api-discovery.md`. Examine the raw response. Document every field found in a sign record: its name, TypeScript type, example values, and any data quirks (date formats, nullable fields, coordinates, enumerations, etc.).

Write the raw API response as `data/latest.json` in the format `{ fetched_at, count, signs }` — this seeds the project with real data for downstream features.

**Output files:**
- `docs/data-schema.md` — full field-by-field documentation of the API response
- `data/latest.json` — real fetched data in `{ fetched_at: string, count: number, signs: RawSign[] }` format

**Evaluator checks:**
- `docs/data-schema.md` exists and documents individual sign fields with types
- `docs/data-schema.md` notes any data quirks (date format, coordinate naming, etc.)
- `data/latest.json` exists, is valid JSON, and has a non-zero `count`
- The signs array in `data/latest.json` contains the fields described in the documentation
