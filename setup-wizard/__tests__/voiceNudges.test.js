import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { DEFAULT_LANGUAGE, LANGUAGES } from '../../frontend/src/config/languages.ts';
import * as conversation from '../../frontend/src/utils/conversation.ts';

const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const ts = require('typescript');
const source = fs.readFileSync(new URL('../../frontend/src/pages/VoicePage.tsx', import.meta.url), 'utf8');
const timerStart = source.indexOf('  function startNudgeTimer()');
const timerEnd = source.indexOf('  function buildSessionConfig(', timerStart);
const handlerStart = source.indexOf('  const handleEvent = useCallback(');
const handlerEnd = source.indexOf('  const cleanupConnection = useCallback(', handlerStart);
const sendStart = source.indexOf('  const sendText = useCallback(');
const sendEnd = source.indexOf('  const login = ', sendStart);
assert.ok(timerStart >= 0 && timerEnd > timerStart && handlerStart >= 0 && handlerEnd > handlerStart
    && sendStart >= 0 && sendEnd > sendStart);
const code = ts.transpileModule(
    source.slice(timerStart, timerEnd) + source.slice(handlerStart, handlerEnd)
        + source.slice(sendStart, sendEnd) + '\n({ startNudgeTimer, handleEvent, sendText });',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

function createSession({ mode = 'voice', language = DEFAULT_LANGUAGE, clips = [] } = {}) {
    let now = 0;
    let timerId = 0;
    const timers = new Map();
    const state = { sent: [], played: [], logs: [], transcript: [] };
    const socket = { readyState: 1 };
    const context = {
        activePreferencesRef: { current: { mode, language } },
        voiceStatusRef: { current: 'ready' },
        wsRef: { current: socket },
        WebSocket: { OPEN: 1 },
        playCtxRef: { current: { currentTime: 0 } },
        nextPlayTimeRef: { current: 0 },
        nudgeClipsRef: { current: clips },
        nudgeLastIndexRef: { current: -1 },
        nudgeTimerRef: { current: null },
        responseGenerationRef: { current: 0 },
        pendingCallsRef: { current: {} },
        agentTextRef: { current: '' },
        NUDGE_DELAY_MS: 15000,
        textInput: 'A new question',
        callState: 'connected',
        Math,
        usesCachedAudio: conversation.usesCachedAudio,
        buildNudgeResponse: language => conversation.buildNudgeResponse(language),
        useCallback: callback => callback,
        getToken: () => null,
        devLog: () => {},
        console: Object.fromEntries(['info', 'warn', 'error'].map(level => [
            level, (...args) => state.logs.push({ level, args }),
        ])),
        setTimeout(callback, delay) {
            const id = ++timerId;
            timers.set(id, { callback, at: now + delay });
            return id;
        },
        clearTimeout: id => timers.delete(id),
        wsSend: event => state.sent.push(event),
        setVoiceStatus(status) {
            context.voiceStatusRef.current = status;
            state.status = status;
        },
        setStatusText: text => { state.message = text; },
        setTextInput: text => { state.input = text; },
        setTranscript: update => { state.transcript = update(state.transcript); },
        scheduleAudio(pcm) {
            state.played.push(pcm);
            context.nextPlayTimeRef.current = Math.max(
                context.nextPlayTimeRef.current, context.playCtxRef.current.currentTime,
            ) + pcm.byteLength / 48000;
        },
        base64ToArrayBuffer: () => new ArrayBuffer(48000),
        clearPlayback: () => { context.nextPlayTimeRef.current = 0; },
    };
    const handlers = vm.runInNewContext(code, context);
    function advance(ms) {
        const until = now + ms;
        let iterations = 0;
        while (true) {
            const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (!next || next[1].at > until) break;
            assert.ok(++iterations < 100, 'Timer should not spin indefinitely');
            now = next[1].at;
            context.playCtxRef.current.currentTime = now / 1000;
            timers.delete(next[0]);
            next[1].callback();
        }
        now = until;
        context.playCtxRef.current.currentTime = now / 1000;
    }
    return { state, context, advance, ...handlers };
}

test('empty nudge cache generates a live check-in after 15 seconds of silence', () => {
    const session = createSession();
    session.startNudgeTimer();
    session.advance(14999);
    assert.equal(session.state.sent.length, 0);
    session.advance(1);
    assert.equal(session.state.sent.length, 1);
    const event = session.state.sent[0];
    assert.equal(event.type, 'response.create');
    assert.deepEqual(event.response.modalities, ['text', 'audio']);
    assert.equal(event.response.tool_choice, 'none');
    assert.ok(event.response.instructions.includes('en-US'));
    assert.equal('voice' in event.response, false, 'Nudges must inherit the configured personal voice');
    assert.equal(session.state.logs.length, 1);
});

test('text chat never starts a nudge timer or generates spoken nudges', () => {
    const session = createSession({ mode: 'chat' });
    session.startNudgeTimer();
    session.advance(60000);
    assert.equal(session.state.sent.length, 0);
    assert.equal(session.state.played.length, 0);
});

test('non-English nudges use the selected language instead of cached English audio', () => {
    const language = LANGUAGES.find(item => item.code === 'hi-IN');
    const session = createSession({ language, clips: [{ phrase: 'Are you there?', pcm: new ArrayBuffer(48000) }] });
    session.startNudgeTimer();
    session.advance(15000);
    assert.equal(session.state.played.length, 0);
    assert.equal(session.state.sent.length, 1);
    assert.ok(session.state.sent[0].response.instructions.includes('hi-IN'));
});

test('a single cached nudge remains playable and waits for playback before repeating', () => {
    const pcm = new ArrayBuffer(48000);
    const session = createSession({ clips: [{ phrase: 'Are you there?', pcm }] });
    session.startNudgeTimer();
    session.advance(15000);
    assert.deepEqual(session.state.played, [pcm]);
    assert.equal(session.state.sent.length, 0);
    session.advance(15999);
    assert.equal(session.state.played.length, 1);
    session.advance(1);
    assert.equal(session.state.played.length, 2);
});

test('user speech cancels the silence timer', () => {
    const session = createSession();
    session.startNudgeTimer();
    session.handleEvent({ type: 'input_audio_buffer.speech_started', item_id: 'user-1' });
    session.advance(60000);
    assert.equal(session.state.sent.length, 0);
    assert.equal(session.context.voiceStatusRef.current, 'listening');
});

test('a new voice response cancels pending nudges before its first audio delta', () => {
    const session = createSession();
    session.startNudgeTimer();
    session.handleEvent({ type: 'response.created' });
    session.advance(60000);
    assert.equal(session.state.sent.length, 0);
    assert.equal(session.context.voiceStatusRef.current, 'speaking');
});

test('typed messages cancel idle nudges while waiting for the server response', () => {
    const session = createSession();
    session.startNudgeTimer();
    session.sendText();
    session.advance(60000);
    assert.equal(session.state.sent.length, 2);
    assert.equal(session.state.sent[0].type, 'conversation.item.create');
    assert.equal(session.state.sent[1].type, 'response.create');
    assert.equal(session.context.voiceStatusRef.current, 'speaking');
});

test('the first nudge waits for buffered audio plus 15 seconds of silence', () => {
    const session = createSession();
    session.context.nextPlayTimeRef.current = 2;
    session.startNudgeTimer();
    session.advance(16999);
    assert.equal(session.state.sent.length, 0);
    session.advance(1);
    assert.equal(session.state.sent.length, 1);
});

test('a live nudge does not repeat until its audio finishes and another silence interval elapses', () => {
    const session = createSession();
    session.startNudgeTimer();
    session.advance(75000);
    assert.equal(session.state.sent.length, 1);
    session.handleEvent({ type: 'response.audio.delta', delta: 'test-audio' });
    session.handleEvent({ type: 'response.audio.done' });
    session.advance(1150);
    assert.equal(session.context.voiceStatusRef.current, 'ready');
    session.advance(14999);
    assert.equal(session.state.sent.length, 1);
    session.advance(1);
    assert.equal(session.state.sent.length, 2);
});

test('failed live nudge synthesis exposes the error without retrying indefinitely', () => {
    const session = createSession();
    session.startNudgeTimer();
    session.advance(15000);
    session.handleEvent({
        type: 'response.done',
        response: { status: 'failed', status_details: { error: { code: 'synthesis_failed', message: 'Unavailable' } } },
    });
    session.advance(60000);
    assert.equal(session.state.sent.length, 1);
    assert.equal(session.state.status, 'error');
    assert.ok(session.state.message.includes('synthesis_failed'));
});

test('pending playback completion does not restart nudges after the user interrupts', () => {
    const session = createSession();
    session.handleEvent({ type: 'response.audio.delta', delta: 'test-audio' });
    session.handleEvent({ type: 'response.audio.done' });
    session.handleEvent({ type: 'input_audio_buffer.speech_started', item_id: 'user-1' });
    session.advance(60000);
    assert.equal(session.context.voiceStatusRef.current, 'listening');
    assert.equal(session.state.sent.length, 0);
});

test('an older response finishing playback cannot mark a newer response ready', () => {
    const session = createSession();
    session.handleEvent({ type: 'response.created' });
    session.handleEvent({ type: 'response.audio.delta', delta: 'test-audio' });
    session.handleEvent({ type: 'response.audio.done' });
    session.handleEvent({ type: 'response.created' });
    session.advance(60000);
    assert.equal(session.context.voiceStatusRef.current, 'speaking');
    assert.equal(session.state.sent.length, 0);
});

test('a timer from a disconnected session cannot send a nudge to a replacement session', () => {
    const session = createSession();
    session.startNudgeTimer();
    session.context.wsRef.current = { readyState: 1 };
    session.advance(60000);
    assert.equal(session.state.sent.length, 0);
});

test('closed connections never receive live nudges', () => {
    const session = createSession();
    session.startNudgeTimer();
    session.context.wsRef.current.readyState = 3;
    session.advance(60000);
    assert.equal(session.state.sent.length, 0);
});

test('a nudge does not interrupt listening, searching, speaking, or an error', () => {
    for (const status of ['listening', 'searching', 'speaking', 'error']) {
        const session = createSession();
        session.startNudgeTimer();
        session.context.voiceStatusRef.current = status;
        session.advance(15000);
        assert.equal(session.state.sent.length, 0, status);
        assert.equal(session.state.played.length, 0, status);
    }
});
