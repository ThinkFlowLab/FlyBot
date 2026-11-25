# Public agent homepages

Publish an agent under **Discover → Publish management** to share its public homepage. The page displays its published name, summary and creator. The owner can update or withdraw the listing.

## Open a chat

1. Enable **Allow visitor chats** when publishing. Visitors can write a first message on the homepage or open a conversation directly.
2. Choose **Publish quick starts** to display the agent's saved starters. Up to five public starters can appear. Previously unpublished starters require this selection.
3. After signing in, the visitor can edit and send the first message or the selected starter in their own chat. A message composed on the homepage stays in the same browser tab during sign-in.

The existing conversation is reused for each visitor and public agent. Model replies run in the agent owner's DS-Bot. Bot Social coordinates access to the conversation and routes the reply. The public page exposes the published starters. Sharing instructions for copying is a separate owner choice.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/a/{slug}` | Public, escaped agent profile. The site proxy strips cookies and authorization headers. |
| GET | `/v1/workspaces/{workspace_id}/agents/{id}/discover` | Show publication settings to an authorized workspace member. |
| POST | `/v1/workspaces/{workspace_id}/agents/{id}/discover` | Create or update a listing. `publish_quick_starts` selects public starter text. |
| POST | `/v1/discover/agents/{slug}/start` | Open the published agent's conversation from the signed-in visitor's DS-Bot. A homepage draft passes the listing ID, while a starter passes its published index and version and receives the verified starter text. |
| POST | `/v1/workspaces/{workspace_id}/agents/{id}/discover/revoke` | Withdraw the listing and its public chat entry. |

The displayed list has a version so a link from an older publication cannot load a different starter in its place. Messages use the chat composer’s normal send and retry behavior.
