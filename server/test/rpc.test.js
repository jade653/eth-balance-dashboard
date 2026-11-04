/**
 * rpc.js 는 legacy 에서 그대로 가져왔지만 legacy 에는 이 파일의 테스트가 없었다.
 * 옮기는 김에 핵심 동작 두 개를 고정해 둔다. 가짜 JSON-RPC 노드를 로컬에 띄워서 확인한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RpcClient } from '../src/rpc.js';

const servers = [];
after(() => servers.forEach((s) => s.close()));

/** handler(body) 의 반환값을 JSON 으로 응답하는 가짜 노드 */
async function fakeNode(handler) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const out = handler(JSON.parse(raw));
    if (typeof out === 'number') {
      res.writeHead(out).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

test('batch: 노드가 응답 순서를 뒤섞어도 요청 순서대로 돌려준다', async () => {
  const url = await fakeNode((reqs) =>
    // 일부러 역순. JSON-RPC 스펙은 배치 응답 순서를 보장하지 않는다.
    reqs.map((r) => ({ jsonrpc: '2.0', id: r.id, result: `${r.method}:${r.params[0]}` })).reverse(),
  );
  const rpc = new RpcClient(url);

  const out = await rpc.batch([
    { method: 'eth_getBalance', params: ['A'] },
    { method: 'eth_getBalance', params: ['B'] },
    { method: 'eth_getBalance', params: ['C'] },
  ]);
  assert.deepEqual(out, ['eth_getBalance:A', 'eth_getBalance:B', 'eth_getBalance:C']);
});

test('첫 엔드포인트가 5xx 면 다음 엔드포인트로 넘어간다', async () => {
  const dead = await fakeNode(() => 502);
  const alive = await fakeNode((r) => ({ jsonrpc: '2.0', id: r.id, result: '0x10' }));
  const rpc = new RpcClient([dead, alive]);

  assert.equal(await rpc.call('eth_blockNumber'), '0x10');
  assert.equal(rpc.stats.failovers, 1);
  assert.equal(rpc.url, alive);
});

test('JSON-RPC 에러는 메서드 이름과 함께 던진다', async () => {
  const url = await fakeNode((r) => ({
    jsonrpc: '2.0', id: r.id, error: { code: -32602, message: 'invalid argument' },
  }));
  const rpc = new RpcClient(url);

  await assert.rejects(rpc.call('eth_getTransactionByHash', ['0x']), /eth_getTransactionByHash: invalid argument/);
});
