import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../deploy.js', import.meta.url), 'utf8');
const start = source.indexOf('function submitDeployment(');
const end = source.indexOf('// Suffix appended', start);
assert.ok(start >= 0 && end > start);
const submitSource = source.slice(start, end);

function deploy({ waitStatus = 0, state = 'Succeeded', resourceError = null } = {}) {
    const calls = [];
    const context = vm.createContext({
        step() {}, log() {}, ok() {},
        spawnAz: args => {
            calls.push(args);
            return { status: args[2] === 'wait' ? waitStatus : 0, stderr: 'wait failed' };
        },
        azJson: () => ({
            properties: { provisioningState: state, outputs: { appUrl: { value: 'https://example.test' } } },
        }),
        tryReadDeploymentError: () => resourceError,
        tryExtractPreflightError: () => { throw new Error('Must not resubmit deployment'); },
        cleanupHint: () => '',
        die: message => { throw new Error(message); },
    });
    vm.runInContext(submitSource, context);
    return {
        calls,
        submit: () => context.submitDeployment({
            name: 'test-deployment', resourceGroup: 'test-group',
            templateFile: 'main.bicep', params: ['location=eastus'],
        }),
    };
}

test('deployment is submitted once without waiting and polled separately', () => {
    const run = deploy();
    assert.equal(run.submit().appUrl, 'https://example.test');
    assert.equal(run.calls.length, 2);
    assert.equal(run.calls[0][2], 'create');
    assert.ok(run.calls[0].includes('--no-wait'));
    assert.equal(run.calls[1][2], 'wait');
    assert.ok(run.calls[1].includes('--created'));
});

test('failed polling reports the underlying resource error', () => {
    const run = deploy({ waitStatus: 1, resourceError: 'Cosmos deployment failed' });
    assert.throws(run.submit, /Cosmos deployment failed/);
    assert.equal(run.calls.length, 2);
});

test('polling timeout is explicit and never resubmits the deployment', () => {
    const run = deploy({ waitStatus: 1 });
    assert.throws(run.submit, /wait failed/);
    assert.equal(run.calls.length, 2);
});

test('outputs are not accepted from an unsuccessful deployment', () => {
    const run = deploy({ state: 'Failed' });
    assert.throws(run.submit, /ended in state: Failed/);
});
