# Meeting notes and action items

Related: [#212](https://github.com/openTeamily/openTeamily/issues/212), [#1](https://github.com/openTeamily/openTeamily/issues/1).

Meeting notes are stored by workspace in the user's DS-Bot. Users can enter a transcript,
generate a draft summary and action items, review and edit the result, and save the meeting.
They can also record or upload up to ten minutes of audio and add the transcription to the notes.

## Routes

All under `/v1/workspaces/{id}/meetings`; session required, writes also require exact Origin and CSRF.
Outsiders get `404`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/` | Keyset page of meetings (`limit=1..100`, optional UUID-hex `cursor`). Items omit transcript/actions but include `action_count`/`done_count`. |
| POST | `/` | Create `{title, started_at?, attendees?, transcript?, summary?, action_items?}` + `Idempotency-Key`. |
| POST | `/draft` | Generate `{draft: {summary, action_items}}` from `{title?, attendees?, transcript}` through the user's DS-Bot text inference. The result remains a draft until the user saves the meeting. |
| GET, POST | `/speech` | Read the local recognizer's readiness or start preparing its model. |
| POST | `/transcribe` | Recognize one base64-encoded 16 kHz mono PCM WAV segment of up to 15 seconds. Returns `{text}`. |
| GET | `/{meeting_id}` | Full meeting incl. transcript and action items. |
| POST | `/{meeting_id}` | `{revision, changes:{...}}`; stale revision `409` with `error.current`. |
| POST | `/{meeting_id}/remove` | Delete (author, owner or admin). |
| GET | `/{meeting_id}/export` | Download the stored meeting as Markdown (`text/markdown`, attachment). Members may read; outsiders `404`. |

`started_at` is Unix seconds (default: now). `attendees` is a list of 0–50 unique names (≤80
chars). `transcript` ≤40,000; `summary` ≤8,000; `action_items` ≤50 items of
`{text (1–500), owner (≤80, optional), done (bool, default false)}`. Titles are unique per
workspace (casefold) and ≤120 chars. Control characters are rejected. The DS-Bot meeting
API accepts up to 512 KiB of JSON so the full text limits also work for multilingual input.

Records use the signed-in runtime owner's storage. Each workspace in that runtime can hold 100 meetings.

## Storage

Additive `meetings` table (`CREATE TABLE IF NOT EXISTS`) with JSON for attendees/action items;
schema `user_version` stays 1. No existing tables or chrome change.

## Page

`/meetings` lists workspace meetings and provides an editor for title, start time, attendees,
summary, transcript and action-item rows (text, owner, done). The editor previews the generated
summary and action items before adding them to the form. Existing completed actions keep their
status. Open a new record in the current workspace from the chat create menu, or return to a saved
record through its link. The editor exports the selected meeting as Markdown. Saved meetings
and received meeting notes also offer a print preview for the selected revision. It includes
the summary and action items with their owners, deadlines, and status. Use the browser print
dialog to print or save the preview as PDF.

Import text or Markdown transcripts and VTT or SRT captions in the meeting editor. Review
the decoded text, then append it to the current transcript or replace the transcript. The
import reads the file in the browser and the meeting save includes the reviewed text.

The meeting action inbox lists tasks assigned to you in received meeting notes. Save an item
directly from the list to your personal Memory to-dos, then reopen the saved copy from the same
row. You can also complete or reopen the personal copy there. The inbox shows its current
Memory status beside the shared action.

The container launch overlay activates DSH's local SenseVoice recognizer. Profiles with the
official Voice Input bundle use its configured local recognizer. The first preparation downloads
the model into the user's volume. The browser previews audio locally and submits segments only
when transcription starts. The meeting stores the reviewed text through the regular save flow.
The default local worker uses one thread and releases its model after one minute idle.
The Compose manager allows 1.5 GiB per user runtime for DS-Bot and the speech worker.
The source project contains synthetic review captures.

## Remaining meeting features

- Live calls, streaming captions and speaker separation.
- Automatically creating tasks/automations from action items.
- Direct PDF or DOCX downloads, saved audio/video attachments, and server-side HTML rendering.
