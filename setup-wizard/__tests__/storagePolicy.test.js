import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../.azure/modules/rag-storage.bicep', import.meta.url), 'utf8');

test('RAG storage explicitly disables anonymous blob access at the account and container levels', () => {
    const account = source.match(/resource storage 'Microsoft\.Storage\/storageAccounts@[^']+' = \{([\s\S]*?)^\}/m)?.[1];
    assert.ok(account, 'Expected the RAG storage account resource');
    assert.match(account, /^\s*allowBlobPublicAccess:\s*false\s*$/m,
        'Customer policy requires an unconditional false on the storage account, including both deployment passes');
    assert.match(account, /^\s*allowSharedKeyAccess:\s*false\s*$/m);
    const container = source.match(/resource container 'Microsoft\.Storage\/storageAccounts\/blobServices\/containers@[^']+' = \{([\s\S]*?)^\}/m)?.[1];
    assert.ok(container, 'Expected the RAG document container');
    assert.match(container, /^\s*publicAccess:\s*'None'\s*$/m);
});
