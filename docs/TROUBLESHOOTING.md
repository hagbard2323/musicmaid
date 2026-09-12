# Troubleshooting

Start in the reviewed checkout as your normal account:

```bash
./scripts/setup.sh doctor
```

Keep the installed revision and short sanitized result. Credentials belong only
in hidden local setup prompts. Never share `.env`, `.setup/`, cookie/grant files,
callback URLs, backups, databases or unfiltered service logs.

| Symptom | Next action |
| --- | --- |
| Unsupported system | Use AlmaLinux 10 x86_64. Other distributions, ARM and container-only installs are outside this beta. |
| Setup refuses sudo/root | Run the entrypoint as your normal user; it requests sudo for protected stages. |
| Install finds an existing bot | Use a managed Update after backup. Do not force fresh installation over its state. |
| No ownership marker | Expected before installation. An unmanaged existing installation is not adopted by creating a marker manually. |
| Build/release preflight fails | Use the clean reviewed candidate and finish its checks/build. Do not edit metadata to suppress the refusal. |
| Wrong bot token or channel/moderator settings | Run Configure, accept its same-guild apply-and-restart step, then Doctor. |
| No Discord commands | Verify Application/Server IDs and the Guild Install with application-command scope. Registration targets the configured server. |
| Cannot join or speak | Check View Channel, Connect and Speak, channel capacity, and your own voice membership. Use Diagnose for the intended channel. |
| Controls open but audio never starts | Inspect audio readiness with Doctor/Diagnose. Discord controls can start while audio services are unavailable. |
| Wrong recording | Use Change version and confirm the replacement. Retry same track intentionally keeps the selected recording. |
| YouTube needs authorization or refuses the host | Reopen Sources for your authorized session. A browser working elsewhere does not establish access from this server. |
| Spotify request plays another source | Metadata credentials alone do not enable original audio. Check original-audio pairing and the actual source label. |
| Spotify playlist is unavailable | Complete separate playlist consent and check current account/app and list-access requirements in Sources. Audio pairing alone is insufficient. |
| Provider authorization expired/revoked | Reconnect through Sources. A restart cannot renew account consent. |
| Rate limit | Wait for the indicated cooldown; repeated searches and restarts do not increase provider access. |
| Track ends early or goes silent | Record exact public link, source, elapsed time and incident ID; Diagnose/Repair. Known previews/restrictions need an explicit alternative. |
| Old/private player is stale | Open current player, then Refresh player. Only Jump to playing message should move through chat history. |
| Watch video reports EMBEDDED/cannot launch | Enable Activities for the same Discord app, check root URL mapping and member access. Reinstalling cannot set the portal flag. |
| Viewer HTTPS fails | Check hostname, DNS, public HTTPS and proxy configuration. Voice audio can be tested independently. |
| Bot repeatedly restarts or remains stopped | Preserve diagnostics; the watchdog/start limit may have stopped a failing runtime. Use a reviewed rollback or operator repair. |
| Rollback rejects database/viewer/proxy compatibility | Choose a matching managed snapshot or investigate the reported change. Do not disable the check. |

Moderators should start with `/music-admin status` and `/music-admin diagnose`.
Repair retries the same selected recording; confirmed scoped restart is available
with a cooldown. Neither action guarantees provider access or corrects a wrong
recording automatically. See [Operations](OPERATIONS.md).

For a reproducible bug, include revision, OS/version, source, expected/observed
behavior, exact public track link and sanitized incident information. Say whether
another member or mobile client reproduces it. Separate a wrong version from an
audio interruption or viewer-only failure. Use [Security](../SECURITY.md) for a
potential vulnerability.
