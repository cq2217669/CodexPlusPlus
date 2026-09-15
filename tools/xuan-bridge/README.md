# xuan-bridge

`xuan-bridge` is the local process boundary for Xuan plugins:

- `xuan-bridge` reads JSON-RPC-like requests from stdin and writes one response per line.
- `xuan-bridge init [output-root]` creates `xuan-plugins.json` and the versioned `xuan-bridge.sqlite` schema.

The bridge implements bounded streaming workspace search, generic and OwlAI
usage adapters, and Chat Completions, Responses and Anthropic polish adapters.
Profiles are selected from `xuan-plugins.json`; credentials are resolved only
inside the bridge and are never returned to the renderer. Mobile requests forward
to `xuan-plus-remote` through `XUAN_MOBILE_BRIDGE_URL`.

Example profile configuration:

```json
{
  "schemaVersion": 1,
  "plugins": {
    "xuan-usage": {
      "defaultProfile": "relay",
      "profiles": {
        "relay": {
          "provider": "generic",
          "baseUrl": "https://relay.example/v1",
          "apiKeyEnv": "XUAN_USAGE_API_KEY"
        }
      }
    },
    "xuan-polish": {
      "defaultProfile": "polish",
      "profiles": {
        "polish": {
          "protocol": "responses",
          "baseUrl": "https://relay.example/v1",
          "model": "polish-model",
          "apiKeyEnv": "XUAN_POLISH_API_KEY"
        }
      }
    }
  }
}
```

Important environment variables:

```text
XUAN_HOME
XUAN_WORKSPACE_ROOTS
XUAN_USAGE_BASE_URL
XUAN_USAGE_API_KEY
XUAN_USAGE_PROVIDER
XUAN_POLISH_BASE_URL
XUAN_POLISH_API_KEY
XUAN_POLISH_MODEL
XUAN_POLISH_PROTOCOL
XUAN_MOBILE_BRIDGE_URL
XUAN_MOBILE_BRIDGE_TOKEN
```
