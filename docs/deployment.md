# Deployment guide

This guide walks you through deploying your agent to Azure.

> **TL;DR**: clone the repo, run `./setup` to fill in `settings.json`, copy `.env.example` to `.env` and paste in your Voice Live API key, then run `./deploy`.

---

## What `./deploy` does

Fully static — no prompts. Reads `settings.json`, validates it, and:

1. Verifies the Azure CLI is installed and you are logged in (`az login`).
2. Switches to the configured subscription.
3. Creates the resource group if it doesn't exist.
4. Submits `infra/main.bicep` — a single deployment that creates Log Analytics, ACR, the user-assigned managed identity (with AcrPull on ACR), the Container Apps Environment, optionally Voice Live + AI Search, and the Container App itself.
5. Builds and pushes your container image via `az acr build`.
6. Registers the deployed app URL as a redirect URI on your Entra (Azure AD) app.
7. Writes the deployed URL back into `settings.json` under `deploy.appUrl`.

If anything in `settings.json` is missing, deploy fails fast and points you back to `./setup`.

---

## Prerequisites

1. **Azure subscription** with Contributor (or Owner) on the resource group you'll use.
2. **Azure CLI** — install from [learn.microsoft.com/cli/azure/install-azure-cli](https://learn.microsoft.com/cli/azure/install-azure-cli). Then `az login`.
3. **Node.js 18+**.
4. **Docker not required** — `az acr build` runs in the cloud.
5. **An Entra app registration** — see [app-registration.md](./app-registration.md). Set up once per tenant.
6. **Voice Live access** — your subscription needs the `gpt-realtime` model. If not enabled, request access at [aka.ms/oaiapply](https://aka.ms/oaiapply).
7. **Voice Live API key** — provide via a `.env` file (copy `.env.example`) or the `AZURE_VOICELIVE_API_KEY` env var. The key is **never written to `settings.json` or the image**.

---

## Setting the API key

```bash
# Easiest: copy the example file and paste your key in
cp .env.example .env
# then edit .env and set AZURE_VOICELIVE_API_KEY=<your-key>
```

Or set it in your shell:

```bash
# bash / zsh
export AZURE_VOICELIVE_API_KEY="<paste-key>"

# PowerShell
$env:AZURE_VOICELIVE_API_KEY = "<paste-key>"
```

Find or create the key in the Azure portal under your Voice Live (Cognitive Services) account → Keys and Endpoint. `.env` is gitignored.

---

## First-run deploy

```bash
./setup           # idempotent; fill in settings.json
./deploy          # bash / zsh
```

or on Windows PowerShell:

```powershell
.\setup.ps1
.\deploy.ps1
```

Expect the first deploy to take **about 30–60 minutes**. The wizard runs two infrastructure passes (pass 2 locks down the Search and ACR networking), each followed by a Container App rollout. In a measured successful run, the ARM deployments took about 39 minutes and the full run about 62 minutes, including the image builds and wizard steps.

Each infrastructure pass is submitted once, then polled for completion for up to
one hour. A polling failure is reported explicitly; it does not resubmit the
deployment or mean that Azure has stopped processing it.

When it finishes:

```
================================================================
  Deployed: https://<your-app>.<region>.azurecontainerapps.io
================================================================
```

---

## Re-deploying

After code or settings changes, just run `./deploy` again. The bicep is idempotent.

| Flag | Purpose |
|---|---|
| `--skip-build`     | Skip image build — useful when only infra/settings changed |
| `--skip-infra`     | Skip the bicep deploy — code-only iteration. Triggers a new revision so the freshly-built image rolls out |
| `--skip-preflight` | Skip the local app smoke-test (backend `import` + frontend typecheck). Don't use this unless you know the container will start. |

Before each deploy we run a **preflight**: import `app.main` locally with the
same env vars the container will see, and run `tsc --noEmit` against the
frontend. This catches the kind of crash that otherwise only shows up
10 minutes later as `CrashLoopBackOff` in Azure.

---

## Troubleshooting

**Personal voice plays the welcome message but live replies are silent**

The welcome and idle-nudge clips are generated at backend startup using Azure TTS.
When both personal-voice settings are configured, they use the Speaker Profile ID
with the `DragonLatestNeural` base model; otherwise they use the standard voice.
The search filler clips continue to use the standard Azure TTS voice.
Personal-voice synthesis errors are reported rather than silently retried with a
standard voice.
If cached nudge audio is unavailable, the client generates a short check-in
through the active Voice Live session instead. This inherits the session's
personal voice and selected language without calling the separate Azure TTS
endpoint. Check-ins wait for 15 seconds of silence after playback, pause during
user speech and agent responses, and are disabled in Text mode. A failed live
check-in is shown as a response error rather than repeatedly retried.
Hearing cached audio does not verify live personal-voice synthesis.
Confirm that the configured personal voice is available on the same Azure
resource used by Voice Live and that the resource has Personal Voice access.
After deploying this code change, restart the backend to regenerate the cached
welcome and nudge clips, then refresh the browser before starting a new call.

Personal voice needs two values in `settings.json` under `customVoice`:
`profileId` and `name`. Both must be the personal voice's Speaker Profile ID GUID,
the value the Voice Live service echoes back as `voice.name` in `session.updated`.
The session sends `name` as `voice.name` with `type: "azure-personal"`. The
Speech Studio display name (for example `dev-voice`) is not the value to use.
If `name` is empty, the app falls back to the standard voice.

The call UI displays errors from failed `response.done` events as well as
standalone `error` events. After deploying the updated frontend, reproduce one
turn and use the displayed error code/message to diagnose the personal voice.
If no error appears, inspect incoming `response.audio.delta` events to distinguish
missing generated audio from browser playback issues. Do not share audio payloads,
access tokens, or WebSocket ticket URLs.

**AI Search pipeline setup returns `source is not allowed by applicable rules`**

This is a Search network-access rejection, not an embeddings or RBAC error.
`publicNetworkAccess: Enabled` still enforces the Search IP firewall. The IP
detected by setup can differ from the IP used to reach Azure through a corporate
proxy, NAT gateway, or VPN.

Confirm the deploying machine's Azure-egress IPv4 with your network administrator
and set `network.deployerIpAddress` in `settings.json` to it. Then run
`.\deploy.ps1 --skip-build` from the same network route, provided a previous
deployment has cached an image reference; otherwise run `.\deploy.ps1`.
Do not use `--skip-infra` or `--search-only` in network mode.

Changing the portal firewall or choosing "All networks" before redeploying is
not a persistent fix: pass 1 reapplies the configured IP rule. If an Azure
network security perimeter governs Search, its rules must also permit this
access; an IP firewall rule alone may not be sufficient.

Pipeline setup failures now make deployment exit with an error rather than
claiming the indexer is ready. In network mode, pass 2 still disables Search
public access before reporting the failure. An existing app or pipeline might
remain available, but the failed setup has not been verified.

**`BadRequest: NetworkAcls is required for this resouce.`**

The Cognitive Services account request must include an explicit `networkAcls`
block. Both the embeddings and Voice Live account templates include this block:
network mode uses `defaultAction: 'Deny'` with public access disabled; non-network
mode uses `defaultAction: 'Allow'` to preserve public access.

After updating the templates, retry `.\deploy.ps1` on Windows
(or `./deploy` on bash). Do not use `--skip-infra`, since the account
definition needs to be redeployed. Deleting the resource group is not required
for this error.

**`AZURE_VOICELIVE_API_KEY env var is not set`**
Set it (see "Setting the API key" above). The script never reads or writes it from disk.

**`Missing settings.<key>`**
Run `./setup` to fill in the missing field. Setup is idempotent — every prompt pre-fills.

**`InvalidTemplateDeployment: Model gpt-realtime is not available in <region>`**
Voice Live is not in every region. Pick `eastus2` or `swedencentral` in setup.

**`AuthorizationFailed` on resource group create**
You need at least **Contributor** on the subscription. Ask your Azure admin.

**App starts but login fails with AADSTS error**
Check your app registration:
- Redirect URI matches `https://<your-app>.<region>.azurecontainerapps.io/` exactly (deploy registers this automatically; if it failed, the warning told you what URI to add)
- The app has the `User.Read` Microsoft Graph permission
- See [app-registration.md](./app-registration.md)

**I need to start over**
Delete the whole resource group:

```bash
az group delete --name <rg> --yes --no-wait
```

Then clear the `deploy` block in `settings.json` (set `appUrl` and `lastDeployedAt` to null) and re-run `./deploy`.

---

## What runs when

- **`./setup`** — edit `settings.json`. Idempotent. Run any time settings need to change.
- **`customize my agent`** *(inside a coding agent like Copilot or Claude Code)* — edits `system_prompt.txt`, knowledge base, etc.
- **`./deploy`** — pushes the current state of the repo to Azure.

The three are independent. You can deploy with default settings and customize later.
