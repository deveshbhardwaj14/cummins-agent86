import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const deploySource = fs.readFileSync(new URL('../deploy.js', import.meta.url), 'utf8');
const pipelineSource = deploySource.slice(
    deploySource.indexOf('function configureSearchIndexer('),
    deploySource.indexOf('function grantSearchAccessToExistingEmbeddings('),
);

function runPipeline({ failLabel, embeddings = { endpoint: 'https://example.cognitiveservices.azure.com', deployment: 'embedding', model: 'text-embedding-3-large' }, runOk = true } = {}) {
    const calls = [];
    const messages = [];
    const context = vm.createContext({
        fs: { writeFileSync() {}, unlinkSync() {} },
        path: { join: (...parts) => parts.join('\\') },
        os: { tmpdir: () => 'temp' },
        log: message => messages.push(message),
        step: message => messages.push(message),
        warn: message => messages.push(message),
        ok: message => messages.push(message),
        az: args => {
            calls.push(args);
            const uri = args[args.indexOf('--uri') + 1];
            const failed = uri.includes(`/${failLabel}/`) || (args[2] === 'POST' && !runOk);
            return { ok: !failed, stderr: failed ? "Request is denied as the source is not allowed by applicable rules. The service is set 'publicNetworkAccess: Enabled'." : '' };
        },
    });
    vm.runInContext(pipelineSource, context);
    const result = context.configureSearchIndexer(
        { azure: { subscriptionId: 'subscription', resourceGroup: 'group' }, network: { deployerIpAddress: '192.0.2.1' } },
        { searchServiceName: 'search', ragStorageAccount: 'storage', ragContainerName: 'docs', searchDataSourceName: 'source', searchIndexName: 'index', searchSkillsetName: 'skills', searchIndexerName: 'indexer' },
        embeddings,
        { networkMode: true },
    );
    return { result, calls, messages };
}

test('missing embeddings fails pipeline setup without making Search requests', () => {
    const { result, calls } = runPipeline({ embeddings: {} });
    assert.equal(result, false);
    assert.equal(calls.length, 0);
});

for (const failLabel of ['datasources', 'indexes', 'skillsets', 'indexers']) {
    test(`${failLabel} failure returns failure and never starts the indexer`, () => {
        const { result, calls, messages } = runPipeline({ failLabel });
        assert.equal(result, false);
        assert.equal(calls.some(args => args[2] === 'POST'), false);
        assert.equal(messages.filter(message => message.includes('Search firewall rejected')).length, 1);
        assert.ok(messages.some(message => message.includes('Manual firewall changes are overwritten')));
        assert.equal(messages.some(message => message.includes('temporarily set "All networks"')), false);
    });
}

test('successful setup creates all four resources and starts the indexer', () => {
    const { result, calls } = runPipeline();
    assert.equal(result, true);
    assert.equal(calls.length, 5);
    assert.equal(calls[4][2], 'POST');
});

test('initial run failure is explicit but preserves the configured scheduled pipeline', () => {
    const { result, messages } = runPipeline({ runOk: false });
    assert.equal(result, true);
    assert.ok(messages.some(message => message.includes('Initial indexer run could not be started')));
});
