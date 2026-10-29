import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LANGUAGE, LANGUAGES, filterLanguages } from '../../frontend/src/config/languages.ts';
import { buildConversationSession, formatDuration, usesCachedAudio } from '../../frontend/src/utils/conversation.ts';

const options = {
    mode: 'voice',
    language: DEFAULT_LANGUAGE,
    instructions: 'Keep the configured persona. Search approved sources.',
    voiceName: 'en-US-Andrew:DragonHDLatestNeural',
    temperature: 0.8,
    vadEagerness: 'medium',
    noiseSuppression: 'azure_deep_noise_suppression',
};

test('English is the default and every locale is unique and searchable', () => {
    assert.equal(DEFAULT_LANGUAGE.code, 'en-US');
    assert.ok(LANGUAGES.length >= 140);
    assert.equal(new Set(LANGUAGES.map(item => item.code)).size, LANGUAGES.length);
    for (const language of LANGUAGES) {
        assert.ok(filterLanguages(language.code).some(item => item.code === language.code));
        assert.ok(language.nativeName);
    }
});

test('language hints match names, native names, and codes without case sensitivity', () => {
    assert.ok(filterLanguages('HINDI').some(item => item.code === 'hi-IN'));
    assert.ok(filterLanguages('हिन्दी').some(item => item.code === 'hi-IN'));
    assert.ok(filterLanguages('fr-ca').some(item => item.code === 'fr-CA'));
    assert.equal(filterLanguages('not-a-language').length, 0);
    assert.equal(filterLanguages('   ').length, LANGUAGES.length);
});

test('chat requests text only, with no voice, transcription, or audio settings', () => {
    const config = buildConversationSession({ ...options, mode: 'chat', personalVoiceName: 'profile' });
    assert.deepEqual(config.modalities, ['text']);
    assert.equal(config.turn_detection, null);
    for (const key of ['voice', 'input_audio_transcription', 'input_audio_sampling_rate', 'input_audio_echo_cancellation', 'input_audio_noise_reduction']) {
        assert.equal(key in config, false);
    }
    assert.equal(config.tools[0].name, 'search_knowledge_base');
});

test('voice preserves standard voice settings and configures the selected transcription locale', () => {
    const language = LANGUAGES.find(item => item.code === 'hi-IN');
    const config = buildConversationSession({ ...options, language });
    assert.deepEqual(config.modalities, ['text', 'audio']);
    assert.equal(config.input_audio_transcription.language, 'hi-IN');
    assert.equal(config.voice.name, options.voiceName);
    assert.equal(config.voice.type, 'azure-standard');
    assert.equal(config.input_audio_sampling_rate, 24000);
    assert.equal(config.turn_detection.type, 'azure_semantic_vad');
    assert.ok(config.instructions.includes(options.instructions));
    assert.ok(config.instructions.includes('Hindi'));
    assert.ok(config.instructions.includes('hi-IN'));
});

test('personal voice remains configured in voice sessions only', () => {
    const config = buildConversationSession({ ...options, personalVoiceName: 'profile' });
    assert.equal(config.voice.type, 'azure-personal');
    assert.equal(config.voice.name, 'profile');
    assert.equal(config.voice.model, 'DragonLatestNeural');
});

test('English cached clips are never used in chat or another language', () => {
    assert.equal(usesCachedAudio('voice', DEFAULT_LANGUAGE), true);
    assert.equal(usesCachedAudio('chat', DEFAULT_LANGUAGE), false);
    assert.equal(usesCachedAudio('voice', LANGUAGES.find(item => item.code === 'hi-IN')), false);
});

test('noise reduction can still be disabled', () => {
    assert.equal('input_audio_noise_reduction' in buildConversationSession({ ...options, noiseSuppression: 'none' }), false);
});

test('duration formatting handles minutes, hours, and pre-start clock ticks', () => {
    assert.equal(formatDuration(0), '00:00');
    assert.equal(formatDuration(65.9), '01:05');
    assert.equal(formatDuration(3601), '60:01');
    assert.equal(formatDuration(-1), '00:00');
});
