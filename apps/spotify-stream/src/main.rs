use std::{io::{self, BufRead, Read, Write}, sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}}, time::{Duration, Instant}};
use librespot::{
    core::{authentication::Credentials, config::SessionConfig, Session, SpotifyUri, spotify_id::SpotifyId},
    metadata::audio::{AudioFileFormat, AudioItem, UniqueFields},
    playback::{audio_backend::{Sink, SinkError, SinkResult}, config::{Bitrate, PlayerConfig}, convert::Converter, decoder::AudioPacket, mixer::NoOpVolume, player::{Player, PlayerEvent}},
};
use serde::Deserialize;
use serde_json::json;
const REVISION: &str = "939dc5ee9d833e1980f9495241219d9d4868a061";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request { access_token: String, device_id: String, track_id: String, expected_duration_ms: u32, #[serde(default)] start_ms: u32 }
struct Output { permitted: Arc<AtomicBool>, bytes: Arc<AtomicU64> }
impl Sink for Output {
    fn write(&mut self, packet: AudioPacket, _: &mut Converter) -> SinkResult<()> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.permitted.load(Ordering::Acquire) {
            if Instant::now() >= deadline { return Err(SinkError::InvalidParams("Recording identity was not confirmed".into())); }
            std::thread::sleep(Duration::from_millis(5));
        }
        let AudioPacket::Raw(data) = packet else { return Err(SinkError::InvalidParams("Expected original Ogg audio".into())); };
        io::stdout().lock().write_all(&data).map_err(|_| SinkError::OnWrite("Audio consumer disconnected".into()))?;
        self.bytes.fetch_add(data.len() as u64, Ordering::Relaxed);
        Ok(())
    }
}
fn report(value: serde_json::Value) { eprintln!("{value}"); }
fn validate(request: &Request) -> Result<(), &'static str> {
    if request.track_id.len() != 22 || !request.track_id.bytes().all(|c| c.is_ascii_alphanumeric()) { return Err("Invalid Spotify track ID"); }
    if request.access_token.is_empty() || request.access_token.len() > 8192 || request.device_id.len() > 64 || request.device_id.is_empty() { return Err("Invalid Spotify authorization input"); }
    if request.expected_duration_ms == 0 || request.expected_duration_ms > 3_600_000 { return Err("Spotify recordings must be between one millisecond and one hour"); }
    if request.start_ms >= request.expected_duration_ms { return Err("Spotify start position is outside the recording"); }
    Ok(())
}
async fn stream(request: Request) -> Result<(), &'static str> {
    validate(&request)?;
    let mut config = SessionConfig::default(); config.device_id = request.device_id; config.autoplay = Some(false);
    let session = Session::new(config, None);
    session.connect(Credentials::with_access_token(request.access_token), false).await.map_err(|_| "Spotify account login was refused")?;
    let id = SpotifyId::from_base62(&request.track_id).map_err(|_| "Invalid Spotify track ID")?;
    let uri = SpotifyUri::Track { id };
    let item = AudioItem::get_file(&session, uri.clone()).await.map_err(|_| "Spotify recording metadata is unavailable for this account")?;
    if item.uri != format!("spotify:track:{}", request.track_id) || item.availability.is_err() { return Err("The exact Spotify recording is unavailable for this account"); }
    if item.duration_ms.abs_diff(request.expected_duration_ms) > 5000 { return Err("Spotify duration differs from the selected recording"); }
    let account = session.get_user_attribute("type");
    if account.as_deref() != Some("premium") { return Err("Spotify Premium could not be confirmed for this account"); }
    let (bitrate, kbps) = if item.files.contains_key(&AudioFileFormat::OGG_VORBIS_320) { (Bitrate::Bitrate320, 320) }
        else if item.files.contains_key(&AudioFileFormat::OGG_VORBIS_160) { (Bitrate::Bitrate160, 160) }
        else if item.files.contains_key(&AudioFileFormat::OGG_VORBIS_96) { (Bitrate::Bitrate96, 96) }
        else {
            let formats: Vec<String> = item.files.keys().map(|format| format!("{format:?}")).collect();
            let alternatives: Vec<String> = item.alternatives.as_ref().map(|tracks| tracks.0.iter().take(5).map(|uri| uri.to_uri()).collect()).unwrap_or_default();
            report(json!({"event":"unavailable_formats", "trackId":request.track_id, "formats":formats, "alternatives":alternatives, "title":item.name, "durationMs":item.duration_ms}));
            return Err("The selected Spotify recording has no supported original Ogg stream");
        };
    let allowed = Arc::new(AtomicBool::new(false)); let bytes = Arc::new(AtomicU64::new(0));
    let gate = allowed.clone(); let counter = bytes.clone();
    let player = Player::new(PlayerConfig { bitrate, passthrough: true, normalisation: false, gapless: false, ..PlayerConfig::default() }, session, Box::new(NoOpVolume), move || Box::new(Output { permitted: gate.clone(), bytes: counter.clone() }));
    let mut events = player.get_player_event_channel();
    player.load(uri.clone(), true, request.start_ms);
    while let Some(event) = events.recv().await {
        match event {
            PlayerEvent::TrackChanged { audio_item } => {
                if audio_item.track_id != uri || audio_item.duration_ms.abs_diff(request.expected_duration_ms) > 5000 { player.stop(); return Err("Spotify returned a different recording; playback refused"); }
                let artists: Vec<String> = match &audio_item.unique_fields { UniqueFields::Track { artists, .. } => artists.0.iter().map(|a| a.name.clone()).collect(), _ => vec![] };
                report(json!({"event":"metadata", "trackId":request.track_id, "title":audio_item.name, "artists":artists, "durationMs":audio_item.duration_ms, "codec":"vorbis", "bitrateKbps":kbps}));
            }
            PlayerEvent::Playing { track_id, position_ms, .. } => {
                if track_id != uri || position_ms.abs_diff(request.start_ms) > 1000 { player.stop(); return Err("Spotify returned an unexpected start position"); }
                report(json!({"event":"start_position", "positionMs":position_ms}));
                allowed.store(true, Ordering::Release);
            }
            PlayerEvent::Unavailable { .. } => { player.stop(); return Err("Spotify did not provide readable original audio; account or audio-key access may be refused"); }
            PlayerEvent::EndOfTrack { track_id, .. } => {
                if track_id != uri || bytes.load(Ordering::Relaxed) == 0 { return Err("Spotify returned no complete audio"); }
                report(json!({"event":"complete", "trackId":request.track_id, "bytes":bytes.load(Ordering::Relaxed)})); return Ok(());
            }
            _ => {}
        }
    }
    Err("Spotify player stopped without completing the recording")
}
#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") { println!("musicmaid-spotify-stream 0.1.0 librespot {REVISION}"); return; }
    let mut line = String::new();
    if io::stdin().lock().take(16_385).read_line(&mut line).is_err() || line.len() > 16_384 { report(json!({"event":"error","reason":"Invalid private request"})); std::process::exit(1); }
    let request = match serde_json::from_str(&line) { Ok(value) => value, Err(_) => { report(json!({"event":"error","reason":"Invalid private request"})); std::process::exit(1); } };
    match tokio::time::timeout(Duration::from_secs(65), stream(request)).await {
        Ok(Ok(())) => {}
        result => { let reason = match result { Ok(Err(reason)) => reason, _ => "Spotify original audio preparation timed out" }; report(json!({"event":"error","reason":reason})); std::process::exit(1); }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use librespot::core::http_client::HttpClient;
    #[test] fn request_rejects_urls_and_missing_auth() {
        let mut r = Request { track_id: "0NTMtAO2BV4tnGvw9EgBVq".into(), access_token: "test".into(), device_id: "device".into(), expected_duration_ms: 219305, start_ms: 0 };
        assert!(validate(&r).is_ok()); r.track_id = "https://localhost".into(); assert!(validate(&r).is_err());
    }
    // Builds both rustls client configurations (hyper-rustls and the vendored proxy connector) from the host CA store; a second rustls crypto provider would panic here before any I/O.
    #[tokio::test] async fn http_client_builds_tls_configuration_without_a_provider_panic() {
        let client = HttpClient::new(None);
        let request = http::Request::get("http://127.0.0.1:9/").body(bytes::Bytes::new()).unwrap();
        assert!(client.request_fut(request).is_ok());
    }
}
