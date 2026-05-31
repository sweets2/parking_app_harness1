## F-D1 API Discovery `[TODO]`

Search for and document the Hoboken city parking enforcement API. A developer starting fresh would need to find this API before writing any fetcher code.

### F-D1.1 Find the API

Search the web for the Hoboken, NJ parking enforcement API. The city operates a public parking permit/sign system. Find the API endpoint, determine what headers or authentication (if any) are required to successfully make a request, and verify that a GET request returns parking sign data.

**Output:** Write `docs/api-discovery.md` documenting:
- The full API endpoint URL
- Any required request headers and their values
- Whether authentication is required
- The top-level response shape (status field, data array, etc.)
- Any rate limiting observed

**Evaluator checks:**
- `docs/api-discovery.md` exists and is non-empty
- It contains an API endpoint URL
- It documents headers required for a successful request
- It describes the top-level response structure
