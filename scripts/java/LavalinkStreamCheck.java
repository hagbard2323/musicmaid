import com.sedmelluq.discord.lavaplayer.player.AudioLoadResultHandler;
import com.sedmelluq.discord.lavaplayer.player.AudioPlayer;
import com.sedmelluq.discord.lavaplayer.player.DefaultAudioPlayerManager;
import com.sedmelluq.discord.lavaplayer.player.event.AudioEventAdapter;
import com.sedmelluq.discord.lavaplayer.source.http.HttpAudioSourceManager;
import com.sedmelluq.discord.lavaplayer.tools.FriendlyException;
import com.sedmelluq.discord.lavaplayer.track.AudioPlaylist;
import com.sedmelluq.discord.lavaplayer.track.AudioTrack;
import com.sedmelluq.discord.lavaplayer.track.AudioTrackEndReason;
import com.sedmelluq.discord.lavaplayer.track.playback.AudioFrame;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Read one private signed URL from stdin; verify actual audio frames without Discord. */
public class LavalinkStreamCheck {
    public static void main(String[] args) throws Exception {
        if (args.length < 1 || args.length > 2 || !args[0].matches("[A-Za-z0-9_-]{11}")) throw new IllegalArgumentException("Supply video ID and optional seek milliseconds");
        long startMs = args.length == 2 ? Long.parseLong(args[1]) : 0;
        String address = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)).readLine();
        URI uri = new URI(address);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || !uri.getHost().endsWith(".googlevideo.com") || uri.getUserInfo() != null) throw new IllegalArgumentException("Only an approved Google media URL may be tested");
        DefaultAudioPlayerManager manager = new DefaultAudioPlayerManager();
        AudioPlayer player = manager.createPlayer();
        AtomicReference<String> error = new AtomicReference<>();
        AtomicReference<AudioTrackEndReason> ended = new AtomicReference<>();
        try {
            manager.registerSourceManager(new HttpAudioSourceManager());
            CompletableFuture<AudioTrack> loaded = new CompletableFuture<>();
            manager.loadItem(address, new AudioLoadResultHandler() {
                public void trackLoaded(AudioTrack track) { loaded.complete(track); }
                public void playlistLoaded(AudioPlaylist playlist) { loaded.completeExceptionally(new Exception("Unexpected playlist")); }
                public void noMatches() { loaded.completeExceptionally(new Exception("No audio found")); }
                public void loadFailed(FriendlyException failure) { loaded.completeExceptionally(new Exception("Audio lookup failed")); }
            });
            AudioTrack track = loaded.get(20, TimeUnit.SECONDS);
            if (track.getInfo().isStream || track.getDuration() < 30000 || track.getDuration() > 900000 || startMs < 0 || startMs >= track.getDuration() - 2000) throw new IllegalStateException("Probe needs a finite track and valid seek position");
            player.addListener(new AudioEventAdapter() {
                public void onTrackException(AudioPlayer p, AudioTrack t, FriendlyException failure) { error.set("AudioException"); }
                public void onTrackStuck(AudioPlayer p, AudioTrack t, long threshold) { error.set("TrackStuck"); }
                public void onTrackEnd(AudioPlayer p, AudioTrack t, AudioTrackEndReason reason) { ended.set(reason); }
            });
            track.setPosition(startMs);
            player.playTrack(track);
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(track.getDuration() - startMs + 45000);
            long frames = 0, bytes = 0, firstFrame = -1, lastFrame = 0, progressAt = System.nanoTime();
            while (ended.get() == null && error.get() == null && System.nanoTime() < deadline) {
                if (System.nanoTime() - progressAt > TimeUnit.SECONDS.toNanos(20)) {
                    System.out.printf("PROGRESS id=%s frames=%d audioMs=%d%n", args[0], frames, lastFrame);
                    System.out.flush(); progressAt = System.nanoTime();
                }
                AudioFrame frame = player.provide();
                if (frame == null) { Thread.sleep(2); continue; }
                if (firstFrame < 0) firstFrame = frame.getTimecode();
                frames++; bytes += frame.getData().length;
                lastFrame = Math.max(lastFrame, frame.getTimecode());
            }
            boolean pass = error.get() == null && ended.get() == AudioTrackEndReason.FINISHED
                && firstFrame >= startMs - 1000 && firstFrame <= startMs + 1000
                && lastFrame >= track.getDuration() - 2000 && frames >= (track.getDuration() - startMs - 2000) / 20;
            System.out.printf("RESULT id=%s pass=%s seekMs=%d expectedMs=%d firstFrameMs=%d lastFrameMs=%d frames=%d bytes=%d end=%s error=%s%n",
                args[0], pass, startMs, track.getDuration(), firstFrame, lastFrame, frames, bytes, ended.get(), error.get());
            if (!pass) throw new IllegalStateException("Full-stream acceptance failed");
        } finally { player.destroy(); manager.shutdown(); }
    }
}
