# fete-bot

WhatsApp moderation bot for the Fete event groups. It runs through Baileys, applies hardcoded link and spam rules, logs everything to SQLite, and exposes a small Railway health endpoint.

## What It Does

- Moderates all joined groups by default
- Can optionally restrict moderation to `ALLOWED_GROUP_JIDS`
- Defaults to `DRY_RUN=true` so nothing is deleted by accident
- Deletes blocked links and selected spam when live
- Warns users with friendlier reason-specific messages
- Tracks strikes per user per group with 7-day expiry
- Lets owners and moderators ban, mute, pardon, remove, undo, and inspect state by DM
- Silently deletes messages from muted users
- Auto-removes banned users if they rejoin
- Logs moderation actions and owner/moderator actions to SQLite
- Exposes `GET /health` for Railway

## Stack

- Node.js 24+
- TypeScript
- `pnpm`
- `@whiskeysockets/baileys`
- `better-sqlite3`
- SQLite on a persistent Railway volume
- Dockerfile deploy on Railway

## Runtime Surfaces

### WhatsApp surfaces

- Group moderation in joined groups by default, or in `ALLOWED_GROUP_JIDS` when set
- Owner / moderator DM command interface
- Reply-based owner / moderator commands inside allowed groups

### HTTP surface

- `GET /health`
  - `200 OK` when the process is running
  - returns `WAITING_FOR_WHATSAPP` until the bot is paired and connected
- `GET /ready`
  - `200 OK` when the bot socket is connected
  - `503 DISCONNECTED` when the bot socket is not connected

### Persistent storage

- `./data/bot.db`
  - `logs`
  - `strikes`
  - `bans`
  - `mutes`
  - `audit_log`

### Session storage

- `./data/auth`

## Safety Defaults

- `DRY_RUN=true` by default
- `ALLOWED_GROUP_JIDS` is optional; when empty, the bot acts in all joined groups
- `OWNER_JIDS`, database moderators, and WhatsApp group admins are never moderated
- The bot never responds in 1:1 chats unless the sender is an owner or moderator using a command
- The bot never acts on its own messages, with an extra self-ID check as defence in depth

## Link Policy

The allowlist is intentionally hardcoded in [src/linkChecker.ts](/Users/abel/dev/personal/fete-bot/src/linkChecker.ts:1). It is business logic, not env configuration.

Allowed:

- `spotify.com`
- `open.spotify.com`
- `music.apple.com`
- `outofofficecollective.co.uk` and all subdomains
- `music.youtube.com` only
- `instagram.com` profile URLs only
- `x.com` profile URLs only
- `twitter.com` profile URLs only
- `tiktok.com` profile URLs only
- `soundcloud.com`
- `mixcloud.com`

Explicitly blocked:

- Ticketing/event platforms: `ra.co`, `dice.fm`, `eventbrite.com`, `skiddle.com`, `ticketmaster.com`, `ticketweb.com`, `seetickets.com`, `billetto.co.uk`, `fixr.co`
- URL shorteners: `bit.ly`, `t.co`, `tinyurl.com`, `ow.ly`, `buff.ly`, `shorturl.at`, `is.gd`, `rebrand.ly`, `cutt.ly`, `rb.gy`, `tiny.cc`, `lnkd.in`
- `chat.whatsapp.com`
- `vm.tiktok.com`
- `youtu.be`

Special rules:

- TikTok only allows profile pages like `tiktok.com/@username`
- TikTok video links like `tiktok.com/@username/video/...` are blocked
- TikTok short share links like `tiktok.com/t/...` are blocked
- Instagram only allows profile pages like `instagram.com/username`
- X / Twitter only allow profile pages like `x.com/username` or `twitter.com/username`
- Only `music.youtube.com` is allowed for YouTube
- General `youtube.com`, `www.youtube.com`, `m.youtube.com`, and `youtu.be` are blocked

## Spam and Moderation Rules

### Spam detection

- WhatsApp invite links are removed
- Same message sent 3+ times within 5 minutes by the same sender is treated as duplicate spam
- 8+ messages within 60 seconds by the same sender is treated as flooding
- Phone numbers trigger a warning only, not a deletion
- Forwarded / heavily forwarded messages are logged for audit only

### Strike system

Deleted violations add a strike for that user in that group. Strikes expire after 7 days.

- Strike 1: normal warning
- Strike 2: warning plus a final-warning notice
- Strike 3: user is flagged for owner review; the bot does not auto-remove them

### Ban system

- Owner / moderator only
- No auto-banning
- If a banned user rejoins an allowlisted group, the bot auto-removes them and DMs owners

### Mute system

- Owner / moderator only
- Muted users receive no warning
- Their messages are silently deleted until the mute expires or is lifted

## Identity Handling

WhatsApp group traffic may come through as `@lid` JIDs instead of `@s.whatsapp.net`. The bot handles both:

- Direct-number owner / moderator commands resolve to `@s.whatsapp.net`
- Reply-based commands can target `@lid` senders directly
- Ban/mute records store the direct JID and the `lid_jid` when available
- Runtime ban/mute checks try both formats

## Owner And Moderator Commands

Permission levels work like this:

- Owners come from `OWNER_JIDS` in the environment
- Moderators come from the SQLite `moderators` table
- WhatsApp group admins are protected from moderation, but do not automatically get bot command access

In practice:

- Owners can run all bot commands and manage moderators with `!addmod` and `!removemod`
- Moderators can run moderation and info commands, but cannot manage moderators
- WhatsApp group admins are exempt from bot moderation actions unless they are also an owner or moderator

Command note:

- `!pardon` and `!resetstrikes` currently do the same thing: clear active strikes and remove any pending review entry for that user in the targeted group(s)

Owners and moderators can control the bot in two ways:

- By DM to the bot
- By replying to a message in a managed group

`OWNER_JIDS` must be full WhatsApp user JIDs such as:

- `447911123456@s.whatsapp.net`

### Owner-only DM commands

- `!addmod {number} {note?}`
- `!removemod {number}`
- `!mods`

### Owner + moderator DM commands

- `!help`
- `!status`
- `!audit {limit?}`
- `!test {url}`
- `!undo`
- `!ban {jid or number} {groupJid?} {reason?}`
- `!unban {jid or number} {groupJid}`
- `!bans {groupJid}`
- `!mute {jid or number} {duration?} {groupJid?}`
- `!unmute {jid or number} {groupJid}`
- `!mutes {groupJid}`
- `!remove {jid or number} {groupJid}`
- `!pardon {jid or number} {groupJid?}`
- `!strikes {jid or number}`
- `!strike {jid or number} {reason?} {groupJid?}`

If exactly one managed group is available, commands that take `{groupJid?}` can omit it. If multiple managed groups are available, pass the raw group JID.

### Reply-based commands in groups

Reply to the target message, then send:

- `!mute {duration?}`
- `!unmute`
- `!ban {reason?}`
- `!strike {reason?}`
- `!pardon`
- `!strikes`
- `!undo`

Reply context always wins over typed numbers.

### Bootstrap

On first deploy, only `OWNER_JIDS` users exist.

- An owner should DM `!addmod {number} {note?}` for each person who needs access
- Owners cannot be removed via commands
- To remove an owner, change `OWNER_JIDS` and redeploy

### Destructive command rate limit

Per owner or moderator:

- max 10 destructive commands per minute across `!ban`, `!mute`, and `!strike`

If exceeded, the bot replies:

- `Slow down — you've run 10 commands in the last minute. Try again shortly.`

### Undo window

After `!ban`, `!mute`, or `!strike`, the bot stores one undo action per owner or moderator for 5 minutes.

- `!undo` reverses the last undoable destructive action if still available

## Number Formats for Commands

Accepted:

- `07911123456`
- `+447911123456`
- `447911123456`
- `00447911123456`
- `447911123456@s.whatsapp.net`
- international formats like `+1 212 555 0123`, `+33 6 12 34 56 78`, `+234 701 234 5678`

Notes:

- Local numbers beginning with `0` are assumed to be UK `+44`
- For non-UK numbers, always use international format with `+`
- `@lid` JIDs are internal and not accepted in direct-number commands
- When in doubt, reply to the message instead of typing the number

## Startup Health Checks

After the bot connects, it runs a non-fatal health check:

- every monitored group can be resolved
- the bot is an admin in each monitored group
- every `OWNER_JIDS` entry is valid
- SQLite is writable

If a critical check fails:

- the bot keeps running
- the failure is logged loudly
- all owners are DM’d with the failure details

## Media Handling

The bot extracts moderation text from:

- plain text messages
- extended text messages
- image captions
- video captions
- document captions
- document-with-caption wrapper messages

This matters because promo spam often hides links in captions rather than body text.

## Audit and Logging

### Moderation log

The `logs` table stores:

- timestamp
- group JID
- user JID
- push name
- message text
- URL found
- action: `DELETED`, `DRY_RUN`, `WARN`, `ERROR`
- reason

### Audit log

The `audit_log` table stores:

- timestamp
- actor JID
- actor role: `owner` or `moderator`
- command
- target JID
- group JID
- raw input
- result: `success`, `error`, `pending`

Use:

- `!audit`
- `!audit 50`

## Versioning and Status

On startup the bot logs:

- bot name
- version from `GIT_COMMIT_SHA` when available, otherwise `dev`
- startup timestamp

`!status` includes:

- version
- started timestamp
- current mode
- monitored groups
- configured owner count
- configured moderator count
- strikes issued today
- total active strikes
- total active bans
- total active mutes
- forwarded messages seen today

## Local Setup

1. Copy `.env.example` to `.env`
2. Fill in your env vars
3. Use the repo-pinned toolchain:

```bash
mise install
mise use
```

4. Install dependencies:

```bash
corepack pnpm install
```

5. Start the bot:

```bash
corepack pnpm dev
```

6. Scan the QR code using the WhatsApp Business account for the Lebara number

## Local Admin CLI

For local testing and maintenance, there is a terminal helper:

```bash
pnpm admin:cli help
```

Useful examples:

```bash
pnpm admin:cli status
pnpm admin:cli test-url "https://ra.co/events/123"
pnpm admin:cli mods list
pnpm admin:cli mods add 07911123456 "sound team"
pnpm admin:cli mods remove 07911123456
pnpm admin:cli strikes list 07911123456
pnpm admin:cli strikes clear 07911123456 120363408759548644@g.us
pnpm admin:cli strikes clear-all 120363408759548644@g.us
pnpm admin:cli strikes clear-all
pnpm admin:cli bans list 120363408759548644@g.us
pnpm admin:cli bans clear 07911123456 120363408759548644@g.us
pnpm admin:cli bans clear-all 120363408759548644@g.us
pnpm admin:cli bans clear-all
pnpm admin:cli mutes list 120363408759548644@g.us
pnpm admin:cli mutes clear 07911123456 120363408759548644@g.us
pnpm admin:cli mutes clear-all 120363408759548644@g.us
pnpm admin:cli mutes clear-all
pnpm admin:cli reset-all 120363408759548644@g.us
pnpm admin:cli reset-all
pnpm admin:cli audit 20
```

Notes:

- This CLI is local-only and talks directly to `./data/bot.db`
- It is intended for testing, inspection, and cleanup
- It does not send WhatsApp messages or bypass bot safety logic in chats
- `clear` and `reset` are equivalent, so existing `reset` commands still work

## Environment Variables

- `DRY_RUN=true|false`
- `ALLOWED_GROUP_JIDS=120363...@g.us,120363...@g.us`
- `OWNER_JIDS=447911123456@s.whatsapp.net,447922234567@s.whatsapp.net`
- `BOT_NAME=Fete Bot`
- `PORT=3000`

## Getting Group JIDs

1. Start the bot
2. Pair the account
3. Watch for `Discovered group` logs on connect
4. Or send any message in a group and look for:

```text
Seen message from group JID: 120363XXXXXXXXXX@g.us
```

5. Optionally add the chosen JIDs to `ALLOWED_GROUP_JIDS` if you want to restrict moderation to specific groups

## Railway Deploy

1. Create a Railway project from this repo
2. Railway will use the included [Dockerfile](/Users/abel/dev/personal/fete-bot/Dockerfile:1) automatically
3. Mount a persistent volume at `/app/data`
4. Set these variables in Railway:

```text
DRY_RUN=true
BOT_NAME=FeteBot
OWNER_JIDS=447911123456@s.whatsapp.net
ALLOWED_GROUP_JIDS=120363408759548644@g.us
NODE_ENV=production
```

5. Deploy
6. Scan the QR code from Railway logs with the WhatsApp Business account
7. Use `/health` for Railway health checks

Notes:

- Do not use `ADMIN_JIDS`; the app reads `OWNER_JIDS`
- `data/` is intentionally excluded from the Docker build so the Railway volume stays authoritative for both the SQLite DB and WhatsApp auth files
- The container listens on Railway's `PORT` env var and falls back to `3000` locally
- Railway deploy health checks should target `/health`, not `/ready`, so the container can become active before the WhatsApp QR has been scanned
- Use `/ready` only if you want to confirm that the bot is fully connected to WhatsApp

## Operational Notes

- The bot must be an admin in each moderated group to delete messages or remove members
- `DRY_RUN=true` still logs what would happen, but does not delete or send moderation replies
- Ticket-platform links get a specific redirect message to `fete.outofofficecollective.co.uk`
- Phone-number spam warns but does not delete
- Muted users are silent-delete only
- Ban and mute enforcement is local to the configured group
- DM commands are ignored for non-authorised users without replying

## Type Check

```bash
mise exec -- pnpm test
```
