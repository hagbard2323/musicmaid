# Member controls

This guide describes the beta checkout. Your operator can confirm the installed
revision with `/music-admin status`; documentation alone does not establish that
your server has updated.

## Add music

1. Join the voice channel, then use `/music` → **Add music**, or `/play` without a query.
2. Enter an artist and title or a supported track link. Keep all configured
   sources, or select the ones you want. Spotify appears when original audio is enabled.
3. Keep **Auto · ask when unsure** for clear-match playback and choices when
   uncertain. Choose **Review versions first** to inspect before queueing.

Version menus show three choices per page. Selecting a choice opens a review;
**Play this version** confirms it. **Preview source** opens the provider website
for you and does not tell the bot to play. Private menus expire and belong to
their requester.

A playable exact link keeps that recording, even if a different search source
is selected. With original Spotify audio disabled, a Spotify link supplies
metadata for another provider's playable match. Read the actual source label.
Metadata and bitrate alone cannot prove the same master or edition.

## Find controls without losing your place

The public **Now playing** card shows the requester, actual source, next tracks
and full controls. **Details** opens recording/request information privately.
Older cards stay compact: **Open current player** opens current controls privately
where you are. **Jump to playing message** is the separate action that scrolls
to the public playing card. Refresh a private player after the song changes.

**Change version** requires **Replace with this version** before changing the
request. A stale confirmation is refused after that request leaves the queue.
**Retry same track** deliberately retries the same selected recording.
**Stop and clear** disconnects and empties the live queue; saved playlists remain.

## Share the queue

FIFO is the default and follows displayed order. Moderators can choose
**Use fair turns** or **Use FIFO order** inside Queue. Fair turns alternate one
track per requester and preserve each person's order; a playlist takes multiple
turns. The policy and rotation survive restart. Switching policy does not stop
the playing track.

Manual moves, Play next and shuffle require FIFO. Removal and clearing remain
available in Fair mode. Repeat-one holds the current turn until repeat changes
or someone skips. Fair turns balance track counts, not minutes. Returning to
FIFO keeps the displayed upcoming order.

Use **Save track**, **Save queue**, **Playlists** and **Stats** for the library.
Creators and moderators edit playlists; everyone can browse, play and export.
See [Playlists and stats](PLAYLISTS.md) for imports, ownership and limits.

## When something fails

Automatic recovery retries the chosen recording; it does not silently play a
different song. If a recording is unavailable, choose another version explicitly.
Tell a moderator the incident ID and approximate elapsed time if it stops early.
Moderators can diagnose, repair and confirm a scoped restart. Expired account
consent still needs the operator's attention.

**Watch video** is optional for YouTube. It follows the exact selected video;
voice audio continues independently. The viewer waits across other sources
while another YouTube track remains queued, and closes when none remains or
playback stops. See [Video](YOUTUBE-VIEWER.md).

## Beta acceptance

These are remaining live checks, not completed results:

- Record the installed revision, then listen for **more than two hours**, including
  full recordings, another member and a Discord mobile client.
- Try source selection, Auto, explicit review, exact links, stale confirmations
  and navigation from multiple older cards.
- Add tracks/playlists from several members; check FIFO/Fair switching,
  repeat-one, queue edits and restored turns after restart.
- Save/export a playlist, then import a copy as another member. Verify ownership,
  order and that import alone does not play music.
- Check pause/resume, seeking, moderator repair and restart recovery. Record wrong
  versions, interruptions and source authorization failures separately.
- Open/close optional video as another member and on mobile; voice must continue.
  Check YouTube → other source → YouTube waiting and resumption.

Share public track links and sanitized incident summaries with the operator.
Never share account data or raw logs.
