import unittest
from unittest.mock import patch
from xml.etree import ElementTree

import httpx

from app import buffer_responses
from app.routes import voice


class GreetingVoiceTests(unittest.TestCase):
    def synthesize(self, **kwargs):
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(200, content=b"greeting-pcm")

        with patch.object(
            buffer_responses.httpx, "Client",
            return_value=httpx.Client(transport=httpx.MockTransport(respond)),
        ):
            pcm = buffer_responses.generate_greeting(
                "https://example.cognitiveservices.azure.com", "test-key",
                "en-US-Andrew:DragonHDLatestNeural", **kwargs,
            )
        self.assertEqual(pcm, b"greeting-pcm")
        self.assertEqual(len(requests), 1)
        return requests[0], ElementTree.fromstring(requests[0].content)

    def test_standard_greeting_preserves_voice_and_output_format(self):
        request, root = self.synthesize()
        element = root.find("{http://www.w3.org/2001/10/synthesis}voice")
        self.assertEqual(element.attrib["name"], "en-US-AndrewNeural")
        self.assertEqual(element.text, buffer_responses.GREETING)
        self.assertEqual(len(element), 0)
        self.assertEqual(request.headers["Ocp-Apim-Subscription-Key"], "test-key")
        self.assertEqual(
            request.headers["X-Microsoft-OutputFormat"], "raw-24khz-16bit-mono-pcm",
        )

    def test_personal_greeting_uses_profile_with_dragon_base_model(self):
        _, root = self.synthesize(personal_voice_profile_id="speaker-profile")
        element = root.find("{http://www.w3.org/2001/10/synthesis}voice")
        self.assertEqual(element.attrib["name"], "DragonLatestNeural")
        embedding = element.find("{https://www.w3.org/2001/mstts}ttsembedding")
        self.assertEqual(embedding.attrib["speakerProfileId"], "speaker-profile")
        self.assertEqual(embedding.text, buffer_responses.GREETING)

    def test_personal_greeting_preserves_bearer_auth(self):
        request, _ = self.synthesize(
            personal_voice_profile_id="speaker-profile", bearer_token="test-token",
        )
        self.assertEqual(request.headers["Authorization"], "Bearer test-token")
        self.assertNotIn("Ocp-Apim-Subscription-Key", request.headers)

    def test_greeting_and_profile_are_xml_escaped(self):
        with patch.object(buffer_responses, "GREETING", "Hi & welcome <everyone>"):
            _, root = self.synthesize(personal_voice_profile_id="profile'\"&<>")
        element = root.find("{http://www.w3.org/2001/10/synthesis}voice")
        embedding = element.find("{https://www.w3.org/2001/mstts}ttsembedding")
        self.assertEqual(embedding.attrib["speakerProfileId"], "profile'\"&<>")
        self.assertEqual(embedding.text, "Hi & welcome <everyone>")

    def test_standard_greeting_text_is_xml_escaped(self):
        with patch.object(buffer_responses, "GREETING", "Hi & welcome <everyone>"):
            _, root = self.synthesize()
        self.assertEqual(
            root.find("{http://www.w3.org/2001/10/synthesis}voice").text,
            "Hi & welcome <everyone>",
        )

    def test_personal_voice_failure_is_not_replaced_with_standard_audio(self):
        requests = []

        def reject(request):
            requests.append(request)
            return httpx.Response(403, text="Personal voice access denied")

        with patch.object(
            buffer_responses.httpx, "Client",
            return_value=httpx.Client(transport=httpx.MockTransport(reject)),
        ), self.assertRaises(httpx.HTTPStatusError):
            buffer_responses.generate_greeting(
                "https://example.cognitiveservices.azure.com", "test-key",
                "en-US-AndrewNeural", personal_voice_profile_id="speaker-profile",
            )
        self.assertEqual(len(requests), 1)

    def test_startup_wires_profile_only_when_live_personal_voice_is_enabled(self):
        for profile, name, expected in [
            ("speaker-profile", "speaker-profile", "speaker-profile"),
            ("speaker-profile", "", ""),
            ("", "speaker-profile", ""),
            ("", "", ""),
        ]:
            with self.subTest(profile=profile, name=name), patch.multiple(
                voice, VOICELIVE_ENDPOINT="https://example.cognitiveservices.azure.com",
                VOICELIVE_API_KEY="test-key", VOICELIVE_AUTH_MODE="key",
                PERSONAL_VOICE_PROFILE_ID=profile, PERSONAL_VOICE_NAME=name,
                _fillers_payload=[], _nudges_payload=[], _greeting_payload={},
            ), patch.object(
                buffer_responses, "generate_fillers", return_value=[],
            ), patch.object(
                buffer_responses, "generate_nudges",
                return_value=[b"nudge-pcm"] * len(buffer_responses.NUDGE_PHRASES),
            ) as nudges, patch.object(
                buffer_responses, "generate_greeting", return_value=b"greeting-pcm",
            ) as greeting:
                voice.init_voice_audio()
                self.assertEqual(
                    greeting.call_args.kwargs.get("personal_voice_profile_id"), expected,
                )
                self.assertEqual(
                    nudges.call_args.kwargs.get("personal_voice_profile_id"), expected,
                )
                self.assertEqual(
                    voice._nudges_payload,
                    [{"phrase": phrase, "audio_b64": "bnVkZ2UtcGNt"}
                     for phrase in buffer_responses.NUDGE_PHRASES],
                )
                self.assertEqual(voice._greeting_payload["audio_b64"], "Z3JlZXRpbmctcGNt")


class NudgeVoiceTests(unittest.TestCase):
    def synthesize(self, **kwargs):
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(200, content=b"nudge-pcm")

        with patch.object(
            buffer_responses.httpx, "Client",
            return_value=httpx.Client(transport=httpx.MockTransport(respond)),
        ):
            pcm = buffer_responses.generate_nudges(
                "https://example.cognitiveservices.azure.com", "test-key",
                "en-US-Andrew:DragonHDLatestNeural", **kwargs,
            )
        self.assertEqual(pcm, [b"nudge-pcm"] * len(buffer_responses.NUDGE_PHRASES))
        self.assertEqual(len(requests), len(buffer_responses.NUDGE_PHRASES))
        return requests

    def test_standard_nudges_preserve_voice_auth_and_output_format(self):
        requests = self.synthesize()
        for request, phrase in zip(requests, buffer_responses.NUDGE_PHRASES):
            root = ElementTree.fromstring(request.content)
            element = root.find("{http://www.w3.org/2001/10/synthesis}voice")
            self.assertEqual(element.attrib["name"], "en-US-AndrewNeural")
            self.assertEqual(element.text, phrase)
            self.assertEqual(len(element), 0)
            self.assertEqual(request.headers["Ocp-Apim-Subscription-Key"], "test-key")
            self.assertEqual(
                request.headers["X-Microsoft-OutputFormat"], "raw-24khz-16bit-mono-pcm",
            )

    def test_every_personal_nudge_uses_profile_with_dragon_base_model(self):
        requests = self.synthesize(personal_voice_profile_id="speaker-profile")
        for request, phrase in zip(requests, buffer_responses.NUDGE_PHRASES):
            root = ElementTree.fromstring(request.content)
            element = root.find("{http://www.w3.org/2001/10/synthesis}voice")
            self.assertEqual(element.attrib["name"], "DragonLatestNeural")
            embedding = element.find("{https://www.w3.org/2001/mstts}ttsembedding")
            self.assertEqual(embedding.attrib["speakerProfileId"], "speaker-profile")
            self.assertEqual(embedding.text, phrase)

    def test_personal_nudges_preserve_bearer_auth_and_sample_rate(self):
        requests = self.synthesize(
            personal_voice_profile_id="speaker-profile",
            bearer_token="test-token", sample_rate=16000,
        )
        for request in requests:
            self.assertEqual(request.headers["Authorization"], "Bearer " + "test-token")
            self.assertNotIn("Ocp-Apim-Subscription-Key", request.headers)
            self.assertEqual(
                request.headers["X-Microsoft-OutputFormat"], "raw-16khz-16bit-mono-pcm",
            )

    def test_nudge_text_and_personal_profile_are_xml_escaped(self):
        for profile in ("", "profile'\"&<>"):
            with self.subTest(profile=profile), patch.object(
                buffer_responses, "NUDGE_PHRASES", ["Any questions & thoughts <yet>?"],
            ):
                requests = self.synthesize(personal_voice_profile_id=profile)
                root = ElementTree.fromstring(requests[0].content)
                element = root.find("{http://www.w3.org/2001/10/synthesis}voice")
                if profile:
                    embedding = element.find("{https://www.w3.org/2001/mstts}ttsembedding")
                    self.assertEqual(embedding.attrib["speakerProfileId"], profile)
                    text = embedding.text
                else:
                    text = element.text
                self.assertEqual(text, "Any questions & thoughts <yet>?")

    def test_personal_nudge_failure_is_not_replaced_with_standard_audio(self):
        requests = []

        def reject(request):
            requests.append(request)
            return httpx.Response(403, text="Personal voice access denied")

        with patch.object(
            buffer_responses.httpx, "Client",
            return_value=httpx.Client(transport=httpx.MockTransport(reject)),
        ), self.assertRaises(httpx.HTTPStatusError):
            buffer_responses.generate_nudges(
                "https://example.cognitiveservices.azure.com", "test-key",
                "en-US-AndrewNeural", personal_voice_profile_id="speaker-profile",
            )
        self.assertEqual(len(requests), 1)


if __name__ == "__main__":
    unittest.main()
