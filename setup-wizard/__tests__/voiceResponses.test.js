import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../frontend/src/pages/VoicePage.tsx', import.meta.url), 'utf8');
const start = source.indexOf('} else if (t === "response.done"');
const end = source.indexOf('} else if (t === "error")', start);
assert.ok(start >= 0 && end > start, 'Expected the failed response event handler');
const handler = source.slice(start, end).replace(/^\} else /, '') + '}';

function handleResponse(response) {
    const state = {
        transcript: [{ role: 'agent', text: 'Partial reply', streaming: true }],
        errors: [],
    };
    vm.runInNewContext(handler, {
        t: 'response.done',
        event: { response },
        console: { error: (...args) => state.errors.push(args) },
        clearNudgeTimer: () => { state.nudgesCleared = true; },
        clearPlayback: () => { state.playbackCleared = true; },
        activePreferencesRef: { current: { mode: 'voice' } },
        agentTextRef: { current: 'Partial reply' },
        setVoiceStatus: value => { state.status = value; },
        setStatusText: value => { state.message = value; },
        setTranscript: update => { state.transcript = update(state.transcript); },
    });
    return state;
}

test('failed synthesis exposes its code and message instead of remaining silent', () => {
    const state = handleResponse({
        status: 'failed',
        status_details: { error: { code: 'synthesis_failed', message: 'Personal voice is unavailable.' } },
    });
    assert.equal(state.status, 'error');
    assert.equal(state.message, 'Error: synthesis_failed: Personal voice is unavailable.');
    assert.equal(state.transcript[0].streaming, false);
    assert.equal(state.transcript[1].role, 'system');
    assert.ok(state.transcript[1].text.includes('synthesis_failed'));
    assert.equal(state.nudgesCleared, true);
    assert.equal(state.playbackCleared, true);
    assert.equal(state.errors.length, 1);
});

test('failed response without error details still reports an explicit failure', () => {
    const state = handleResponse({ status: 'failed' });
    assert.equal(state.status, 'error');
    assert.ok(state.message.includes('Voice response failed'));
});

test('failed response can report a status reason', () => {
    const state = handleResponse({ status: 'failed', status_details: { reason: 'Synthesis unavailable' } });
    assert.equal(state.message, 'Error: Synthesis unavailable');
});

for (const status of ['completed', 'cancelled', 'incomplete']) {
    test(`${status} response is not incorrectly reported as a synthesis failure`, () => {
        const state = handleResponse({ status });
        assert.equal(state.status, undefined);
        assert.equal(state.transcript.length, 1);
        assert.equal(state.errors.length, 0);
    });
}
