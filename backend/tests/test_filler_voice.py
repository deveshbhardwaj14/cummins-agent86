import base64
import json
import unittest
from collections import deque
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from app import buffer_responses
from app.routes import voice


class FillerVoiceTests(unittest.TestCase):
    def generate(self, frames=None, **kwargs):
        events = deque()
        sent = []
        upstream = Mock()

        def send(message):
            event = json.loads(message)
            sent.append(event)
            if event["type"] == "session.update":
                events.extend([
                    {"type": "session.created"},
                    {"type": "session.updated"},
                ])
            else:
                self.assertEqual(event["type"], "response.create")
                events.extend(frames if frames is not None else [
                    {"type": "response.audio.delta", "delta": base64.b64encode(b"pcm-").decode()},
                    {"type": "response.audio.delta", "delta": base64.b64encode(b"audio").decode()},
                    {"type": "response.audio.done"},
                    {"type": "response.done", "response": {"status": "completed"}},
                ])

        upstream.send.side_effect = send
        upstream.recv.side_effect = lambda *, timeout: json.dumps(events.popleft())
        with patch.object(buffer_responses, "ws_connect", create=True) as connect, patch.object(
            buffer_responses, "_synthesize_phrases",
        ) as standard_tts:
            connect.return_value.__enter__.return_value = upstream
            clips = buffer_responses.generate_fillers(
                "https://example.cognitiveservices.azure.com/", "test-key",
                "en-US-Andrew:DragonHDLatestNeural",
                personal_voice_name="speaker-profile",
                voice_live_model="configured-model",
                voice_live_api_version="2025-10-01",
                **kwargs,
            )
            standard_tts.assert_not_called()
            options = connect.call_args
        return clips, sent, options, upstream

    def test_personal_fillers_use_one_voice_live_session_and_cache_all_pcm_clips(self):
        clips, sent, options, upstream = self.generate()
        self.assertEqual(clips, [b"pcm-audio"] * len(buffer_responses.FILLER_PHRASES))
        self.assertEqual(buffer_responses._cached_fillers, clips)
        url = urlsplit(options.args[0])
        self.assertEqual(url.scheme, "wss")
        self.assertEqual(url.path, "/voice-live/realtime")
        self.assertEqual(parse_qs(url.query), {
            "api-version": ["2025-10-01"], "model": ["configured-model"],
        })
        self.assertEqual(options.kwargs["additional_headers"], {"api-key": "test-key"})
        self.assertNotIn("test-key", options.args[0])
        session = sent[0]["session"]
        self.assertEqual(session["voice"], {
            "type": "azure-personal", "name": "speaker-profile", "model": "DragonLatestNeural",
        })
        self.assertEqual(session["modalities"], ["text", "audio"])
        self.assertEqual(session["output_audio_format"], "pcm16")
        self.assertIsNone(session["turn_detection"])
        self.assertEqual(session["tools"], [])
        self.assertEqual(session["tool_choice"], "none")
        self.assertEqual(len(sent), 1 + len(buffer_responses.FILLER_PHRASES))
        for event, phrase in zip(sent[1:], buffer_responses.FILLER_PHRASES):
            self.assertEqual(event["type"], "response.create")
            self.assertEqual(event["response"]["tool_choice"], "none")
            self.assertIn(json.dumps(phrase), event["response"]["instructions"])
            self.assertNotIn("voice", event["response"])
        self.assertTrue(all(call.kwargs["timeout"] > 0 for call in upstream.recv.call_args_list))

    def test_personal_fillers_preserve_bearer_auth_and_requested_sample_rate(self):
        _, sent, options, _ = self.generate(bearer_token="test-token", sample_rate=16000)
        self.assertEqual(options.kwargs["additional_headers"], {"Authorization": "Bearer " + "test-token"})
        self.assertNotIn("test-token", options.args[0])
        self.assertEqual(sent[0]["session"]["output_audio_format"], "pcm16_16000hz")

    def test_standard_fillers_keep_the_existing_tts_path(self):
        with patch.object(
            buffer_responses, "_synthesize_phrases", return_value=[b"standard-pcm"],
        ) as tts, patch.object(buffer_responses, "ws_connect", create=True) as connect:
            clips = buffer_responses.generate_fillers(
                "https://example.cognitiveservices.azure.com", "test-key",
                "en-US-AndrewNeural", bearer_token="test-token",
            )
            self.assertEqual(clips, [b"standard-pcm"])
            tts.assert_called_once_with(
                buffer_responses.FILLER_PHRASES,
                "https://example.cognitiveservices.azure.com", "test-key",
                "en-US-AndrewNeural", 24000, bearer_token="test-token",
            )
            connect.assert_not_called()

    def test_service_errors_are_explicit_and_do_not_reuse_standard_fillers(self):
        with patch.object(buffer_responses, "_cached_fillers", [b"old-standard-audio"]):
            with self.assertRaisesRegex(RuntimeError, "voice_unavailable.*Personal voice is unavailable"):
                self.generate(frames=[{
                    "type": "error",
                    "error": {"code": "voice_unavailable", "message": "Personal voice is unavailable"},
                }])
            self.assertEqual(buffer_responses._cached_fillers, [])

    def test_failed_or_incomplete_responses_are_not_cached_as_success(self):
        for status in ("failed", "cancelled", "incomplete"):
            with self.subTest(status=status), self.assertRaisesRegex(RuntimeError, status):
                self.generate(frames=[
                    {"type": "response.audio.delta", "delta": base64.b64encode(b"partial").decode()},
                    {"type": "response.done", "response": {
                        "status": status,
                        "status_details": {"error": {"code": "synthesis_failed", "message": "Unavailable"}},
                    }},
                ])
            self.assertEqual(buffer_responses._cached_fillers, [])

    def test_empty_audio_is_an_explicit_failure(self):
        with self.assertRaisesRegex(RuntimeError, "no audio"):
            self.generate(frames=[{"type": "response.done", "response": {"status": "completed"}}])

    def test_synthesis_has_a_total_deadline_even_if_unrelated_events_keep_arriving(self):
        with patch.object(
            buffer_responses, "monotonic", create=True, side_effect=[0, 1, 2, 61],
        ), self.assertRaisesRegex(TimeoutError, "personal-voice filler"):
            self.generate()

    def test_personal_fillers_reject_unsupported_audio_rates_before_connecting(self):
        with self.assertRaisesRegex(ValueError, "sample rate"):
            self.generate(sample_rate=48000)

    def test_personal_fillers_require_the_configured_model_and_api_version(self):
        for model, api_version in ((None, "2025-10-01"), ("configured-model", None)):
            with self.subTest(model=model, api_version=api_version), self.assertRaisesRegex(
                ValueError, "model and API version",
            ):
                buffer_responses.generate_fillers(
                    "https://example.cognitiveservices.azure.com", "test-key",
                    "en-US-AndrewNeural", personal_voice_name="speaker-profile",
                    voice_live_model=model, voice_live_api_version=api_version,
                )

    def test_startup_does_not_keep_standard_payload_when_personal_generation_fails(self):
        with patch.multiple(
            voice, VOICELIVE_ENDPOINT="https://example.cognitiveservices.azure.com",
            VOICELIVE_API_KEY="test-key", VOICELIVE_AUTH_MODE="key",
            PERSONAL_VOICE_PROFILE_ID="speaker-profile", PERSONAL_VOICE_NAME="speaker-profile",
            _fillers_payload=[{"phrase": "Old filler", "audio_b64": "standard-audio"}],
        ), patch.object(
            buffer_responses, "generate_fillers", side_effect=RuntimeError("Personal filler failed"),
        ), self.assertRaisesRegex(RuntimeError, "Personal filler failed"):
            try:
                voice.init_voice_audio()
            finally:
                self.assertEqual(voice._fillers_payload, [])

    def test_personal_fillers_stay_cached_if_later_nudge_tts_generation_fails(self):
        with patch.multiple(
            voice, VOICELIVE_ENDPOINT="https://example.cognitiveservices.azure.com",
            VOICELIVE_API_KEY="test-key", VOICELIVE_AUTH_MODE="key",
            PERSONAL_VOICE_PROFILE_ID="configured-profile", PERSONAL_VOICE_NAME="configured-voice-name",
            _fillers_payload=[], _nudges_payload=[], _greeting_payload={},
        ), patch.object(
            buffer_responses, "generate_fillers",
            return_value=[b"personal-pcm"] * len(buffer_responses.FILLER_PHRASES),
        ) as fillers, patch.object(
            buffer_responses, "generate_nudges", side_effect=RuntimeError("Nudge TTS failed"),
        ):
            with self.assertRaisesRegex(RuntimeError, "Nudge TTS failed"):
                voice.init_voice_audio()
            self.assertEqual(fillers.call_args.kwargs["personal_voice_name"], "configured-voice-name")
            self.assertEqual(
                voice._fillers_payload,
                [{"phrase": phrase, "audio_b64": base64.b64encode(b"personal-pcm").decode()}
                 for phrase in buffer_responses.FILLER_PHRASES],
            )


if __name__ == "__main__":
    unittest.main()
